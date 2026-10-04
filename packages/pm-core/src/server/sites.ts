import { and, eq } from 'drizzle-orm';
import { type DB } from '@allenlabs/pm-core/db/client';
import { type Site, siteMembers, sites, users } from '@allenlabs/pm-core/db/schema';
import { ForbiddenError, canManageSiteRole } from '@allenlabs/pm-core/lib/permissions';

// Sites (0013) — the TOP partition of a single-DB multi-site deployment. A site
// is a first-class, separately-managed entity sitting ABOVE the org/group tree
// (a site is NOT "the root group"). When an auth identity carries a site key,
// the login-time membership sync resolves/creates the `pm.sites` row, records
// the user as a plain site member, and scopes their synced groups to it.

interface FindOrCreateSiteInput {
  /** Stable external IdP id; matched first when present. */
  externalId?: string | null;
  slug: string;
  name: string;
}

/**
 * Find a site by external id (when given) or slug, else create it. Sites are
 * intentionally simple: matched/created idempotently so a repeated login claim
 * reuses the same row rather than duplicating it.
 */
export async function findOrCreateSiteImpl(
  db: DB,
  input: FindOrCreateSiteInput,
): Promise<typeof sites.$inferSelect> {
  if (input.externalId) {
    const byExt = await db.query.sites.findFirst({
      where: eq(sites.externalId, input.externalId),
    });
    if (byExt) return byExt;
  }
  const bySlug = await db.query.sites.findFirst({ where: eq(sites.slug, input.slug) });
  if (bySlug) return bySlug;
  const [created] = await db
    .insert(sites)
    .values({ slug: input.slug, name: input.name, externalId: input.externalId ?? null })
    .returning();
  /* v8 ignore next */
  if (!created) throw new Error('failed to create site');
  return created;
}

/** Upsert a site membership (idempotent on (site_id, user_id); updates the role). */
export async function upsertSiteMemberImpl(
  db: DB,
  siteId: number,
  userId: number,
  role: string,
): Promise<void> {
  await db
    .insert(siteMembers)
    .values({ siteId, userId, role })
    .onConflictDoUpdate({
      target: [siteMembers.siteId, siteMembers.userId],
      set: { role },
    });
}

// ── URL site-scoping (resolve + authorize the current site per request) ──────
//
// A consuming app puts the current site in the URL (e.g. /s/<slug>/…). Each
// request resolves that slug to a site and authorizes membership ONCE via
// resolveSiteAccessImpl, then threads the returned `site.id` into the scoped
// domain impls (listProjectsImpl, loadHomeImpl, …) as `siteId`.

/** Resolve a URL slug to its site, or null when no such site exists. */
export async function getSiteBySlugImpl(db: DB, slug: string): Promise<Site | null> {
  const row = await db.query.sites.findFirst({ where: eq(sites.slug, slug) });
  return row ?? null;
}

/**
 * The sites a user belongs to, each with their role — for the consumer's landing
 * decision (0 ⇒ onboarding, 1 ⇒ auto-enter, 2+ ⇒ selector). An unrecognized
 * stored role is coerced to the least-privilege `member` so a site is never
 * hidden from a member.
 */
export async function listSitesForUserImpl(
  db: DB,
  userId: number,
): Promise<Array<{ site: Site; role: SiteRoleName }>> {
  const rows = await db
    .select({ site: sites, role: siteMembers.role })
    .from(siteMembers)
    .innerJoin(sites, eq(sites.id, siteMembers.siteId))
    .where(eq(siteMembers.userId, userId))
    .orderBy(sites.slug);
  return rows.map((r) => ({ site: r.site, role: isSiteRole(r.role) ? r.role : 'member' }));
}

/**
 * The single per-request entry point for site-scoping: resolve `slug` → site and
 * authorize the user. Returns `{ site, role }` for a member (`role` is their site
 * role); `null` when the site doesn't exist OR the user isn't a member — the
 * consumer turns null into a 404/redirect. A platform admin (global users.admin)
 * may be allowed through as a non-member via opts (role `null`).
 */
export async function resolveSiteAccessImpl(
  db: DB,
  slug: string,
  userId: number,
  opts: { allowPlatformAdmin?: boolean; isPlatformAdmin?: boolean } = {},
): Promise<{ site: Site; role: SiteRoleName | null } | null> {
  const site = await getSiteBySlugImpl(db, slug);
  if (!site) return null;
  const role = await siteRoleOfImpl(db, site.id, userId);
  if (role != null) return { site, role };
  if (opts.allowPlatformAdmin && opts.isPlatformAdmin) return { site, role: null };
  return null;
}

// ── Administration ──────────────────────────────────────────────────────────
//
// These impls are pure (they take `db` only); ACCESS CONTROL IS THE CONSUMER'S
// JOB. A site is administered out of band, so a consumer wires these behind its
// own admin gate — e.g. a server fn that calls `requireAdmin()` (the global
// `users.admin` flag) before delegating here. Granting `owner`/`admin` is what
// gives a user project-manager perms across the whole site (permissionsForSiteRole).

/** The assignable site roles. `member` = belongs only; `owner`/`admin` = manage. */
export const SITE_ROLES = ['owner', 'admin', 'member'] as const;
export type SiteRoleName = (typeof SITE_ROLES)[number];

export function isSiteRole(role: string): role is SiteRoleName {
  return (SITE_ROLES as readonly string[]).includes(role);
}

/** All sites, ordered by slug — for an admin listing. */
export function listSitesImpl(db: DB): Promise<(typeof sites.$inferSelect)[]> {
  return db.select().from(sites).orderBy(sites.slug);
}

export interface SiteMemberRow {
  userId: number;
  login: string;
  email: string;
  role: string;
}

/** A site's members (joined to users), ordered by login — for an admin listing. */
export function listSiteMembersImpl(db: DB, siteId: number): Promise<SiteMemberRow[]> {
  return db
    .select({
      userId: siteMembers.userId,
      login: users.login,
      email: users.email,
      role: siteMembers.role,
    })
    .from(siteMembers)
    .innerJoin(users, eq(siteMembers.userId, users.id))
    .where(eq(siteMembers.siteId, siteId))
    .orderBy(users.login);
}

/**
 * Set a user's role on a site (owner | admin | member), upserting the row. This
 * is the admin entry point for granting site owner/admin. Rejects an unknown
 * role string (fail-closed) so a typo can't silently create a no-perms grant.
 */
export async function setSiteMemberRoleImpl(
  db: DB,
  siteId: number,
  userId: number,
  role: SiteRoleName,
): Promise<void> {
  if (!isSiteRole(role)) throw new Error(`Unknown site role "${role}".`);
  await upsertSiteMemberImpl(db, siteId, userId, role);
}

/** Remove a user from a site (revokes any site-level grant). */
export async function removeSiteMemberImpl(
  db: DB,
  siteId: number,
  userId: number,
): Promise<void> {
  await db
    .delete(siteMembers)
    .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.userId, userId)));
}

/** The user's current site role, or null when they're not a member (or the
 *  stored value isn't a recognized site role). */
async function siteRoleOfImpl(
  db: DB,
  siteId: number,
  userId: number,
): Promise<SiteRoleName | null> {
  const [row] = await db
    .select({ role: siteMembers.role })
    .from(siteMembers)
    .where(and(eq(siteMembers.siteId, siteId), eq(siteMembers.userId, userId)))
    .limit(1);
  return row && isSiteRole(row.role) ? row.role : null;
}

// ── Delegated administration (a site owner/admin managing their own site) ─────
//
// The `*As*` variants enforce the site role hierarchy from the ACTING user's
// own site role (see canManageSiteRole): owner manages owners; admin tops out at
// admin and cannot touch owners. A global service admin should NOT route through
// these — they use the unrestricted setSiteMemberRoleImpl / removeSiteMemberImpl
// (gate those on the global users.admin flag instead).

/**
 * Set `targetUserId`'s site role AS `actorUserId` — authorized by the actor's
 * own site role. Throws ForbiddenError when the actor outranks neither the
 * target's current role nor the role being granted; rejects an unknown role.
 */
export async function setSiteMemberRoleAsImpl(
  db: DB,
  input: { siteId: number; actorUserId: number; targetUserId: number; role: SiteRoleName },
): Promise<void> {
  const { siteId, actorUserId, targetUserId, role } = input;
  if (!isSiteRole(role)) throw new Error(`Unknown site role "${role}".`);
  const actorRole = await siteRoleOfImpl(db, siteId, actorUserId);
  const currentRole = await siteRoleOfImpl(db, siteId, targetUserId);
  // You cannot demote yourself (lower your own rank) — a step-down must be done
  // by a higher/peer site admin (or a global service admin). A lower SITE_ROLES
  // index = higher rank, so a larger index for the new role is a demotion.
  if (
    actorUserId === targetUserId &&
    currentRole != null &&
    SITE_ROLES.indexOf(role) > SITE_ROLES.indexOf(currentRole)
  ) {
    throw new ForbiddenError('You cannot demote yourself.');
  }
  if (!canManageSiteRole(actorRole, currentRole, role)) {
    throw new ForbiddenError('Insufficient site role to assign this role.');
  }
  await upsertSiteMemberImpl(db, siteId, targetUserId, role);
}

/**
 * Remove `targetUserId` from the site AS `actorUserId`. Throws ForbiddenError
 * when the actor does not outrank (or match) the target's current role — e.g.
 * an admin cannot evict an owner.
 */
export async function removeSiteMemberAsImpl(
  db: DB,
  input: { siteId: number; actorUserId: number; targetUserId: number },
): Promise<void> {
  const { siteId, actorUserId, targetUserId } = input;
  // You cannot remove yourself — an eviction must come from another site admin
  // (or a global service admin via the unrestricted removeSiteMemberImpl).
  if (actorUserId === targetUserId) {
    throw new ForbiddenError('You cannot remove yourself from a site.');
  }
  const actorRole = await siteRoleOfImpl(db, siteId, actorUserId);
  const currentRole = await siteRoleOfImpl(db, siteId, targetUserId);
  if (!canManageSiteRole(actorRole, currentRole, null)) {
    throw new ForbiddenError('Insufficient site role to remove this member.');
  }
  await removeSiteMemberImpl(db, siteId, targetUserId);
}
