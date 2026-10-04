import { and, eq, isNull } from 'drizzle-orm';
import { type DB } from '@allenlabs/pm-core/db/client';
import { groupMembers, groups } from '@allenlabs/pm-core/db/schema';
import type { AuthIdentity } from './auth/types';
import { findOrCreateSiteImpl, upsertSiteMemberImpl } from './sites';

// The local group tree (0012) — the source of truth for org/team hierarchy.
// When an auth identity carries org/team membership claims, `syncMembershipsImpl`
// mirrors them into `groups` (matched/created by `external_id`) + `group_members`
// on login, nesting a team under its org when the claim carries one; otherwise
// the tables are authoritative on their own. No assumption is made about the IdP.

export type GroupKind = 'organization' | 'team';

interface FindOrCreateGroupInput {
  externalId?: string | null;
  slug: string;
  name: string;
  kind?: GroupKind;
  /** Parent group id; undefined/null ⇒ a root group. */
  parentId?: number | null;
  /** Owning site (0013); undefined/null ⇒ siteless. */
  siteId?: number | null;
}

/**
 * Reject parenting `groupId` under `parentId` if that would form a cycle
 * (parentId is the group itself or one of its descendants). Walks UP from the
 * proposed parent; reaching `groupId` means it sits below it. The `seen` set
 * tolerates a pre-existing data loop without hanging.
 */
export async function assertAcyclicParentImpl(
  db: DB,
  groupId: number,
  parentId: number,
): Promise<void> {
  let cursor: number | null = parentId;
  const seen = new Set<number>();
  while (cursor != null) {
    if (cursor === groupId) throw new Error('A group cannot be nested under itself or a descendant.');
    if (seen.has(cursor)) break;
    seen.add(cursor);
    const [row] = await db
      .select({ parentId: groups.parentId })
      .from(groups)
      .where(eq(groups.id, cursor))
      .limit(1);
    cursor = row ? row.parentId : null;
  }
}

export async function setGroupParentImpl(
  db: DB,
  groupId: number,
  parentId: number | null,
): Promise<void> {
  if (parentId != null) await assertAcyclicParentImpl(db, groupId, parentId);
  await db
    .update(groups)
    .set({ parentId: parentId ?? null, updatedAt: new Date() })
    .where(eq(groups.id, groupId));
}

export async function findOrCreateGroupImpl(
  db: DB,
  input: FindOrCreateGroupInput,
): Promise<typeof groups.$inferSelect> {
  const parentId = input.parentId ?? null;
  const siteId = input.siteId ?? null;
  if (input.externalId) {
    const byExt = await db.query.groups.findFirst({
      where: eq(groups.externalId, input.externalId),
    });
    if (byExt) {
      // Mirror a moved subtree: if the claim now places it under a different
      // parent, re-parent it (cycle-checked).
      if (input.parentId !== undefined && parentId !== byExt.parentId) {
        await setGroupParentImpl(db, byExt.id, parentId);
        return { ...byExt, parentId };
      }
      return byExt;
    }
  }
  // Sibling-unique within a site (site_id, parent_id, slug): reuse a same-named
  // sibling under the same site/parent if present.
  const bySibling = await db.query.groups.findFirst({
    where: and(
      parentId == null ? isNull(groups.parentId) : eq(groups.parentId, parentId),
      siteId == null ? isNull(groups.siteId) : eq(groups.siteId, siteId),
      eq(groups.slug, input.slug),
    ),
  });
  if (bySibling) return bySibling;
  const [created] = await db
    .insert(groups)
    .values({
      siteId,
      parentId,
      kind: input.kind ?? 'organization',
      slug: input.slug,
      name: input.name,
      externalId: input.externalId ?? null,
    })
    .returning();
  /* v8 ignore next */
  if (!created) throw new Error('failed to create group');
  return created;
}

export async function upsertGroupMemberImpl(
  db: DB,
  groupId: number,
  userId: number,
  role: string,
): Promise<void> {
  await db
    .insert(groupMembers)
    .values({ groupId, userId, role })
    .onConflictDoUpdate({
      target: [groupMembers.groupId, groupMembers.userId],
      set: { role },
    });
}

/**
 * Mirror an identity's site + org/team membership claims into the local tables.
 *
 * When the identity carries a `site` key (the top partition), it is resolved to
 * a `pm.sites` row, the user is recorded as a plain site member, and every group
 * synced below is scoped to that site. Site owner/admin (which grants broad
 * project access) is intentionally NOT derived from a login claim — a site is
 * administered separately. Org claims become 'organization' groups; team claims
 * become 'team' groups nested under their org (when the claim carries one) or
 * flat roots otherwise. A no-op when the identity carries no claims at all (the
 * tables stay authoritative).
 */
export async function syncMembershipsImpl(
  db: DB,
  userId: number,
  identity: AuthIdentity,
): Promise<void> {
  let siteId: number | undefined;
  if (identity.site) {
    const site = await findOrCreateSiteImpl(db, {
      externalId: identity.site,
      slug: identity.site,
      name: identity.site,
    });
    siteId = site.id;
    // Plain membership only — owner/admin is managed out of band.
    await upsertSiteMemberImpl(db, site.id, userId, 'member');
  }
  for (const m of identity.orgMemberships ?? []) {
    const slug = m.orgSlug ?? m.orgId;
    const org = await findOrCreateGroupImpl(db, {
      externalId: m.orgId,
      slug,
      name: m.orgName ?? slug,
      kind: 'organization',
      siteId,
    });
    await upsertGroupMemberImpl(db, org.id, userId, m.role);
  }
  for (const t of identity.teamMemberships ?? []) {
    let parentId: number | undefined;
    if (t.orgId) {
      const orgSlug = t.orgSlug ?? t.orgId;
      const org = await findOrCreateGroupImpl(db, {
        externalId: t.orgId,
        slug: orgSlug,
        name: orgSlug,
        kind: 'organization',
        siteId,
      });
      parentId = org.id;
    }
    const team = await findOrCreateGroupImpl(db, {
      externalId: t.teamId,
      slug: t.teamId,
      name: t.teamName ?? t.teamId,
      kind: 'team',
      parentId,
      siteId,
    });
    await upsertGroupMemberImpl(db, team.id, userId, t.role);
  }
}
