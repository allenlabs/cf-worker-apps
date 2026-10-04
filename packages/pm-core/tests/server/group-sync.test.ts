import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type TestDB, insertUser, makeTestDb } from '../../src/testing/db';
import { groupMembers, groups } from '@allenlabs/pm-core/db/schema';
import type { AuthIdentity } from '@allenlabs/pm-core/server/auth/types';
import {
  assertAcyclicParentImpl,
  findOrCreateGroupImpl,
  setGroupParentImpl,
  syncMembershipsImpl,
} from '@allenlabs/pm-core/server/groups';

let db: TestDB;
let userId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const u = await insertUser(db, { login: 'u', email: 'u@x.test' });
  userId = u.id;
});

const baseId = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({
  subject: 'sub-1',
  email: 'u@x.test',
  ...over,
});

describe('syncMembershipsImpl → group tree', () => {
  it('is a no-op when the identity carries no memberships', async () => {
    await syncMembershipsImpl(db, userId, baseId());
    expect(await db.query.groups.findMany()).toEqual([]);
    expect(await db.query.groupMembers.findMany()).toEqual([]);
  });

  it('creates an organization group + member from an org claim', async () => {
    await syncMembershipsImpl(
      db,
      userId,
      baseId({ orgMemberships: [{ orgId: 'ext-acme', orgSlug: 'acme', orgName: 'Acme', role: 'admin' }] }),
    );
    const g = await db.query.groups.findFirst({ where: eq(groups.externalId, 'ext-acme') });
    expect(g?.kind).toBe('organization');
    expect(g?.parentId).toBeNull();
    const m = await db.query.groupMembers.findFirst({ where: eq(groupMembers.userId, userId) });
    expect(m?.role).toBe('admin');
  });

  it('nests a team under its org when the team claim carries one', async () => {
    await syncMembershipsImpl(
      db,
      userId,
      baseId({
        teamMemberships: [
          { teamId: 'ext-core', teamName: 'Core', orgId: 'ext-acme', orgSlug: 'acme', role: 'lead' },
        ],
      }),
    );
    const org = await db.query.groups.findFirst({ where: eq(groups.externalId, 'ext-acme') });
    const team = await db.query.groups.findFirst({ where: eq(groups.externalId, 'ext-core') });
    expect(org?.kind).toBe('organization');
    expect(team?.kind).toBe('team');
    expect(team?.parentId).toBe(org!.id); // nested
  });

  it('creates a flat root team when the team claim has no org', async () => {
    await syncMembershipsImpl(db, userId, baseId({ teamMemberships: [{ teamId: 'solo', role: 'member' }] }));
    const team = await db.query.groups.findFirst({ where: eq(groups.externalId, 'solo') });
    expect(team?.kind).toBe('team');
    expect(team?.parentId).toBeNull();
  });

  it('is idempotent and updates the role + re-parents on re-sync', async () => {
    // First: team under org A.
    await syncMembershipsImpl(
      db,
      userId,
      baseId({ teamMemberships: [{ teamId: 'tt', orgId: 'oa', orgSlug: 'a', role: 'member' }] }),
    );
    // Re-sync: same team, now under org B, role lead.
    await syncMembershipsImpl(
      db,
      userId,
      baseId({ teamMemberships: [{ teamId: 'tt', orgId: 'ob', orgSlug: 'b', role: 'lead' }] }),
    );
    const team = await db.query.groups.findFirst({ where: eq(groups.externalId, 'tt') });
    const orgB = await db.query.groups.findFirst({ where: eq(groups.externalId, 'ob') });
    expect(team?.parentId).toBe(orgB!.id); // moved subtree
    const mems = await db.query.groupMembers.findMany({ where: eq(groupMembers.userId, userId) });
    expect(mems.find((m) => m.groupId === team!.id)?.role).toBe('lead'); // role updated
    // one team row reused (matched by external_id), not duplicated
    expect((await db.query.groups.findMany({ where: eq(groups.externalId, 'tt') })).length).toBe(1);
  });

  it('derives slug/name from ids when the claim omits them', async () => {
    await syncMembershipsImpl(db, userId, baseId({ orgMemberships: [{ orgId: 'ext-x', role: 'member' }] }));
    const g = await db.query.groups.findFirst({ where: eq(groups.externalId, 'ext-x') });
    expect(g?.slug).toBe('ext-x'); // slug ← orgId fallback
    expect(g?.name).toBe('ext-x'); // name ← slug fallback
  });

  it('derives the org slug from its id for a nested team claim without orgSlug', async () => {
    await syncMembershipsImpl(
      db,
      userId,
      baseId({ teamMemberships: [{ teamId: 'tt', orgId: 'oo', role: 'member' }] }),
    );
    const org = await db.query.groups.findFirst({ where: eq(groups.externalId, 'oo') });
    expect(org?.slug).toBe('oo'); // orgSlug ← orgId fallback
  });
});

describe('group helpers', () => {
  it('matches an existing sibling by (parent, slug) without an external id', async () => {
    const first = await findOrCreateGroupImpl(db, { slug: 'root', name: 'Root' });
    const again = await findOrCreateGroupImpl(db, { slug: 'root', name: 'Root' });
    expect(again.id).toBe(first.id);
    expect(first.externalId).toBeNull();
  });

  it('returns an existing external-id group unchanged when no re-parent is requested', async () => {
    const g = await findOrCreateGroupImpl(db, { externalId: 'e1', slug: 's1', name: 'S1' });
    const same = await findOrCreateGroupImpl(db, { externalId: 'e1', slug: 's1', name: 'S1' });
    expect(same.id).toBe(g.id);
  });
});

describe('cycle prevention', () => {
  it('rejects making a group its own parent', async () => {
    const g = await findOrCreateGroupImpl(db, { slug: 'g', name: 'G' });
    await expect(setGroupParentImpl(db, g.id, g.id)).rejects.toThrow(/itself or a descendant/);
  });

  it('rejects nesting a group under one of its descendants', async () => {
    const a = await findOrCreateGroupImpl(db, { slug: 'a', name: 'A' });
    const b = await findOrCreateGroupImpl(db, { slug: 'b', name: 'B', parentId: a.id });
    // a is an ancestor of b; parenting a under b would cycle.
    await expect(assertAcyclicParentImpl(db, a.id, b.id)).rejects.toThrow(/descendant/);
  });

  it('allows a valid re-parent and detach (null)', async () => {
    const a = await findOrCreateGroupImpl(db, { slug: 'a', name: 'A' });
    const b = await findOrCreateGroupImpl(db, { slug: 'b', name: 'B' });
    await setGroupParentImpl(db, b.id, a.id); // valid
    expect((await db.query.groups.findFirst({ where: eq(groups.id, b.id) }))?.parentId).toBe(a.id);
    await setGroupParentImpl(db, b.id, null); // detach
    expect((await db.query.groups.findFirst({ where: eq(groups.id, b.id) }))?.parentId).toBeNull();
  });

  it('ends the walk at a dangling parent (missing ancestor row)', async () => {
    const g = await findOrCreateGroupImpl(db, { slug: 'g', name: 'G' });
    // 999999 doesn't exist → the walk's row lookup returns nothing → terminate.
    await expect(assertAcyclicParentImpl(db, g.id, 999999)).resolves.toBeUndefined();
  });

  it('tolerates a pre-existing data loop while checking', async () => {
    const a = await findOrCreateGroupImpl(db, { slug: 'a', name: 'A' });
    const b = await findOrCreateGroupImpl(db, { slug: 'b', name: 'B', parentId: a.id });
    await db.update(groups).set({ parentId: b.id }).where(eq(groups.id, a.id)); // a↔b loop
    const c = await findOrCreateGroupImpl(db, { slug: 'c', name: 'C' });
    // Walking up from a (in the loop) must terminate via `seen`, not reach c.
    await expect(assertAcyclicParentImpl(db, c.id, a.id)).resolves.toBeUndefined();
  });
});
