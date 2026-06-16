import { and, eq } from 'drizzle-orm';
import { type DB } from '@allenlabs/pm-core/db/client';
import { siteMembers, sites, users } from '@allenlabs/pm-core/db/schema';

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
