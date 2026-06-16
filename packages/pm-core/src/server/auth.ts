import { eq, inArray, isNotNull } from 'drizzle-orm';
import { type DB } from '@allenlabs/pm-core/db/client';
import {
  groupMembers,
  groups,
  members,
  projects,
  roles,
  siteMembers,
  users,
} from '@allenlabs/pm-core/db/schema';
import type { Env } from '@allenlabs/pm-core/lib/env';
import {
  type AuthContext,
  type Permission,
  ForbiddenError,
  UnauthorizedError,
  hasPermission,
  permissionsForGroupRole,
  permissionsForSiteRole,
  permissionsForTeamRole,
} from '@allenlabs/pm-core/lib/permissions';
import { type TeamMembershipClaim } from './session.server';
import type { AuthAdapter, AuthIdentity } from './auth/types';
import { syncMembershipsImpl } from './groups';

export interface CurrentUser {
  id: number;
  login: string;
  email: string;
  firstname: string;
  lastname: string;
  isAdmin: boolean;
  avatarUrl: string | null;
  // Better Auth user id (JWT `sub`). Needed to act on the user's behalf
  // against the auth-api org/team bridge.
  betterAuthUserId?: string | null;
  // Suite-wide profile fields (synced from the auth JWT on sign-in).
  username?: string | null;
  preferredName?: string | null;
  // Per-team (= per-project) memberships from the JWT — the Phase 2 source of
  // truth for collaboration RBAC. Carried so buildAuthContext can derive
  // per-project permissions without another DB hop.
  teamMemberships?: TeamMembershipClaim[];
}

// ---------- testable impls ----------

/**
 * Build the permissions matrix for a user.  Two callable shapes:
 *
 *   - `buildAuthContextImpl(db, userId)` — looks the user up to fetch
 *     their `admin` flag.  Used by tests and by any callsite that only
 *     has a user id.
 *   - `buildAuthContextImpl(db, currentUser)` — pass the already-known
 *     CurrentUser to skip the `users.findFirst` round-trip.  Saves a
 *     full Hetzner RTT (~150 ms) on every loader that already called
 *     `getCurrentUser()` upstream — which is essentially every route.
 *
 * Phase 2: per-project permissions now derive from TWO sources, unioned:
 *   1. The JWT's `teamMemberships` (the new source of truth) — each team maps
 *      to a project via `projects.auth_team_id`, and the team role maps to a
 *      PM permission set (see permissionsForTeamRole).
 *   2. The legacy `pm.members` + `pm.roles` path — kept working as a fallback
 *      during the transition.
 * The `teamMemberships` are read off the passed CurrentUser when present, or
 * from the explicit `teamMemberships` arg (tests / callers with a bare id).
 */
export async function buildAuthContextImpl(
  db: DB,
  userIdOrCurrent: number | CurrentUser,
  teamMemberships?: TeamMembershipClaim[],
): Promise<AuthContext> {
  let userId: number;
  let isAdmin: boolean;
  let teams: TeamMembershipClaim[] = teamMemberships ?? [];
  if (typeof userIdOrCurrent === 'number') {
    userId = userIdOrCurrent;
    const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
    if (!user) throw new UnauthorizedError();
    isAdmin = user.admin;
  } else {
    userId = userIdOrCurrent.id;
    isAdmin = userIdOrCurrent.isAdmin;
    // Prefer the explicit arg, else the memberships carried on the user.
    if (!teamMemberships && userIdOrCurrent.teamMemberships) {
      teams = userIdOrCurrent.teamMemberships;
    }
  }

  const permissionsByProject: Record<number, Set<Permission>> = {};
  const add = (projectId: number, perms: Iterable<Permission>) => {
    const existing = permissionsByProject[projectId] ?? new Set<Permission>();
    for (const p of perms) existing.add(p);
    permissionsByProject[projectId] = existing;
  };

  // 1. Team-membership (Phase 2) — resolve team ids → project ids in one query.
  if (teams.length > 0) {
    const teamIds = teams.map((t) => t.teamId);
    const teamProjects = await db
      .select({ id: projects.id, authTeamId: projects.authTeamId })
      .from(projects)
      .where(inArray(projects.authTeamId, teamIds));
    const projectIdByTeam = new Map<string, number>();
    for (const p of teamProjects) {
      // The inArray filter guarantees authTeamId is non-null in results; the
      // guard only narrows the type.
      /* v8 ignore next */
      if (p.authTeamId) projectIdByTeam.set(p.authTeamId, p.id);
    }
    for (const t of teams) {
      const projectId = projectIdByTeam.get(t.teamId);
      if (projectId === undefined) continue;
      add(projectId, permissionsForTeamRole(t.role));
    }
  }

  // 2. Legacy pm.members path (fallback / transition).
  const memberships = await db
    .select({
      projectId: members.projectId,
      permissions: roles.permissions,
    })
    .from(members)
    .innerJoin(roles, eq(members.roleId, roles.id))
    .where(eq(members.userId, userId));
  for (const m of memberships) {
    add(m.projectId, m.permissions as Permission[]);
  }

  // 3. Group-tree membership (0012). Membership on a group inherits DOWN to all
  //    descendant groups + their projects, so for each project attached to a
  //    group we walk UP the ancestor chain and union the perms of any group the
  //    user belongs to. No-op for deployments with no group rows. Ancestry is
  //    resolved in-memory from a parent map (no recursive CTE); the `seen` set
  //    bounds the walk so a (defensively-handled) data cycle can't hang it.
  const groupMemRows = await db
    .select({ groupId: groupMembers.groupId, role: groupMembers.role })
    .from(groupMembers)
    .where(eq(groupMembers.userId, userId));
  if (groupMemRows.length > 0) {
    const roleByGroup = new Map(groupMemRows.map((g) => [g.groupId, g.role]));
    const allGroups = await db.select({ id: groups.id, parentId: groups.parentId }).from(groups);
    const parentOf = new Map(allGroups.map((g) => [g.id, g.parentId]));
    const groupProjects = await db
      .select({ id: projects.id, groupId: projects.groupId })
      .from(projects)
      .where(isNotNull(projects.groupId));
    for (const p of groupProjects) {
      /* v8 ignore next */
      if (p.groupId == null) continue; // isNotNull guarantees non-null
      let cursor: number | null = p.groupId;
      const seen = new Set<number>();
      while (cursor != null) {
        if (seen.has(cursor)) break; // pre-existing data cycle — stop walking
        seen.add(cursor);
        const role = roleByGroup.get(cursor);
        if (role) add(p.id, permissionsForGroupRole(role));
        cursor = parentOf.get(cursor) ?? null;
      }
    }
  }

  // 4. Site membership (0013). A site is the TOP partition; an owner/admin on a
  //    site manages every project belonging to it, while a plain `member` only
  //    belongs (no broad grant — that comes from project/group membership). So
  //    we collect the sites where the user holds a perms-granting role and union
  //    those perms onto every project in each such site. No-op when the user has
  //    no site rows, or only plain-member rows.
  const siteMemRows = await db
    .select({ siteId: siteMembers.siteId, role: siteMembers.role })
    .from(siteMembers)
    .where(eq(siteMembers.userId, userId));
  if (siteMemRows.length > 0) {
    const permsBySite = new Map<number, Set<Permission>>();
    for (const s of siteMemRows) {
      const perms = permissionsForSiteRole(s.role);
      if (perms.size > 0) permsBySite.set(s.siteId, perms);
    }
    if (permsBySite.size > 0) {
      const siteIds = [...permsBySite.keys()];
      const siteProjects = await db
        .select({ id: projects.id, siteId: projects.siteId })
        .from(projects)
        .where(inArray(projects.siteId, siteIds));
      for (const p of siteProjects) {
        /* v8 ignore next */
        if (p.siteId == null) continue; // inArray guarantees non-null
        add(p.id, permsBySite.get(p.siteId)!); // siteId ∈ permsBySite keys
      }
    }
  }

  return { userId, isAdmin, permissionsByProject };
}

/**
 * Resolve the local users row for the holder of the given session cookie.
 * Returns null when the cookie is missing/expired/invalid, when the JWT
 * doesn't map to any local row yet (first-time SSO sign-in hasn't gone
 * through /auth/callback yet), or when the row is locked.
 */
export async function userFromSessionImpl(
  db: DB,
  adapter: AuthAdapter,
  env: Env,
  cookie: string | null,
): Promise<CurrentUser | null> {
  const identity = await adapter.verify(env, cookie);
  if (!identity) return null;
  return userFromIdentityImpl(db, identity);
}

/**
 * Resolve the local users row for an already-verified identity. Split out so a
 * tenant-aware runtime can verify first (cheap, JWT-only), pick the tenant DB
 * from the identity, then do the lookup against that DB.
 */
export async function userFromIdentityImpl(
  db: DB,
  identity: AuthIdentity,
): Promise<CurrentUser | null> {
  const row = await db.query.users.findFirst({
    where: eq(users.betterAuthUserId, identity.subject),
  });
  if (!row || row.status !== 'active') return null;

  // Keep the local handle/preferred name in step with the identity (Phase 1
  // profile fields). Only write when something actually changed so we don't
  // pay a write on every request.
  const claimUsername = identity.username ?? null;
  const claimPreferred = identity.preferredName ?? null;
  if (
    (claimUsername !== null && claimUsername !== row.username) ||
    (claimPreferred !== null && claimPreferred !== row.preferredName)
  ) {
    await db
      .update(users)
      .set({
        username: claimUsername ?? row.username,
        preferredName: claimPreferred ?? row.preferredName,
      })
      .where(eq(users.id, row.id));
  }

  return {
    id: row.id,
    login: row.login,
    email: row.email,
    firstname: row.firstname,
    lastname: row.lastname,
    isAdmin: row.admin,
    avatarUrl: row.avatarUrl,
    betterAuthUserId: row.betterAuthUserId,
    username: claimUsername ?? row.username,
    preferredName: claimPreferred ?? row.preferredName,
    teamMemberships: identity.teamMemberships ?? [],
  };
}

/**
 * Find or create the local users row for a freshly-authenticated SSO user.
 * Called once at /auth/callback after the JWT has been verified.
 *
 * Lookup order:
 *   1. better_auth_user_id == payload.sub   (returning user)
 *   2. email == payload.email                (existing local user migrating
 *                                              from password / GitHub OAuth;
 *                                              we backfill the link)
 *   3. neither matches → INSERT new row     (truly new user; first-ever
 *                                              user gets admin=1 as the
 *                                              instance bootstrap)
 */
export async function findOrCreateUserBySsoImpl(
  db: DB,
  identity: AuthIdentity,
): Promise<CurrentUser> {
  const user = await findOrCreateUserRowImpl(db, identity);
  // Mirror any org/team membership claims into the local tables (no-op when the
  // identity carries none — the tables stay authoritative).
  await syncMembershipsImpl(db, user.id, identity);
  return user;
}

async function findOrCreateUserRowImpl(
  db: DB,
  identity: AuthIdentity,
): Promise<CurrentUser> {
  const email = identity.email.toLowerCase().trim();

  const claimUsername = identity.username ?? null;
  const claimPreferred = identity.preferredName ?? null;

  // 1. Direct link by better_auth_user_id.  Cold-start connection-level
  // retries are handled centrally in `~/db/client` (the postgres.js client
  // is proxied to retry once on connection-shaped errors).
  const linked = await db.query.users.findFirst({
    where: eq(users.betterAuthUserId, identity.subject),
  });
  if (linked) {
    await db
      .update(users)
      .set({
        lastLoginAt: new Date(),
        username: claimUsername ?? linked.username,
        preferredName: claimPreferred ?? linked.preferredName,
      })
      .where(eq(users.id, linked.id));
    return toCurrentUser({
      ...linked,
      username: claimUsername ?? linked.username,
      preferredName: claimPreferred ?? linked.preferredName,
    });
  }

  // 2. Existing user matched by email — backfill the link.
  if (email) {
    const byEmail = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (byEmail) {
      await db
        .update(users)
        .set({
          betterAuthUserId: identity.subject,
          lastLoginAt: new Date(),
          username: claimUsername ?? byEmail.username,
          preferredName: claimPreferred ?? byEmail.preferredName,
        })
        .where(eq(users.id, byEmail.id));
      /* v8 ignore next 2 */
      const refreshed =
        (await db.query.users.findFirst({ where: eq(users.id, byEmail.id) })) ?? byEmail;
      return toCurrentUser(refreshed);
    }
  }

  // 3. Brand-new user — derive login from email local-part, dedupe with a
  // numeric suffix if needed.  First user becomes the instance admin.
  if (!email) {
    throw new Error('Cannot create user without an email claim in the JWT.');
  }
  const baseLogin = email.split('@')[0]?.replace(/[^a-z0-9._-]+/gi, '') || 'user';
  const login = await pickAvailableLogin(db, baseLogin);
  const count = await db.select({ id: users.id }).from(users).limit(1);
  const isFirstUser = count.length === 0;
  const [name1 = '', ...nameRest] = (identity.displayName ?? '').trim().split(/\s+/);
  const [created] = await db
    .insert(users)
    .values({
      login,
      email,
      firstname: name1,
      lastname: nameRest.join(' '),
      betterAuthUserId: identity.subject,
      username: claimUsername,
      preferredName: claimPreferred,
      admin: isFirstUser,
      status: 'active',
      lastLoginAt: new Date(),
    })
    .returning();
  /* v8 ignore next */
  if (!created) throw new Error('Failed to insert new user.');
  return toCurrentUser(created);
}

async function pickAvailableLogin(db: DB, base: string): Promise<string> {
  for (let i = 0; i < 32; i++) {
    const candidate = i === 0 ? base : `${base}${i}`;
    const clash = await db.query.users.findFirst({ where: eq(users.login, candidate) });
    if (!clash) return candidate;
  }
  // Astronomically unlikely; bail with a timestamp suffix.
  /* v8 ignore next */
  return `${base}${Date.now()}`;
}

function toCurrentUser(row: typeof users.$inferSelect): CurrentUser {
  return {
    id: row.id,
    login: row.login,
    email: row.email,
    firstname: row.firstname,
    lastname: row.lastname,
    isAdmin: row.admin,
    avatarUrl: row.avatarUrl,
    betterAuthUserId: row.betterAuthUserId,
    username: row.username,
    preferredName: row.preferredName,
  };
}

export function checkPermission(
  ctx: AuthContext,
  projectId: number,
  permission: Permission,
): void {
  if (!hasPermission(ctx, projectId, permission)) throw new ForbiddenError();
}

// The TanStack Start–aware runtime helpers (`getEnv`, `getCurrentUser`,
// `requirePermission`, …) live in a sibling module: `./auth-runtime.server`.
// Importing them from there directly keeps this file free of SSR runtime
// imports, so it can be loaded from the wrangler integration test worker.
