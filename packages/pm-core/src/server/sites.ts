import { eq } from 'drizzle-orm';
import { type DB } from '@allenlabs/pm-core/db/client';
import { siteMembers, sites } from '@allenlabs/pm-core/db/schema';

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
