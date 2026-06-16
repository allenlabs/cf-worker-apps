import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  type TestDB,
  addManager,
  insertProject,
  insertUser,
  makeTestDb,
} from '../../src/testing/db';
import { groups, siteMembers, sites } from '@allenlabs/pm-core/db/schema';
import type { AuthIdentity } from '@allenlabs/pm-core/server/auth/types';
import { findOrCreateSiteImpl, upsertSiteMemberImpl } from '@allenlabs/pm-core/server/sites';
import { syncMembershipsImpl } from '@allenlabs/pm-core/server/groups';
import { buildAuthContextImpl } from '@allenlabs/pm-core/server/auth';
import { hasPermission, permissionsForSiteRole } from '@allenlabs/pm-core/lib/permissions';

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

describe('permissionsForSiteRole', () => {
  it('grants owner/admin everything and member nothing', () => {
    expect(permissionsForSiteRole('owner').has('delete_project')).toBe(true);
    expect(permissionsForSiteRole('admin').has('manage_members')).toBe(true);
    expect(permissionsForSiteRole('member').size).toBe(0); // belonging only
    expect(permissionsForSiteRole('bogus').size).toBe(0); // fail-closed
  });
});

describe('findOrCreateSiteImpl', () => {
  it('creates a new site', async () => {
    const s = await findOrCreateSiteImpl(db, { slug: 'acme', name: 'Acme' });
    expect(s.slug).toBe('acme');
    expect(s.externalId).toBeNull();
  });

  it('matches an existing site by external id', async () => {
    const first = await findOrCreateSiteImpl(db, { externalId: 'ext-1', slug: 'a', name: 'A' });
    const again = await findOrCreateSiteImpl(db, { externalId: 'ext-1', slug: 'renamed', name: 'X' });
    expect(again.id).toBe(first.id); // external id wins over the changed slug
  });

  it('matches an existing site by slug when no external id is given', async () => {
    const first = await findOrCreateSiteImpl(db, { slug: 's', name: 'S' });
    const again = await findOrCreateSiteImpl(db, { slug: 's', name: 'S2' });
    expect(again.id).toBe(first.id);
  });
});

describe('upsertSiteMemberImpl', () => {
  it('inserts then updates the role idempotently', async () => {
    const site = await findOrCreateSiteImpl(db, { slug: 'a', name: 'A' });
    await upsertSiteMemberImpl(db, site.id, userId, 'member');
    await upsertSiteMemberImpl(db, site.id, userId, 'admin'); // re-sync upgrades
    const rows = await db.query.siteMembers.findMany({ where: eq(siteMembers.userId, userId) });
    expect(rows.length).toBe(1);
    expect(rows[0]?.role).toBe('admin');
  });
});

describe('syncMembershipsImpl → site scoping', () => {
  it('resolves the site, records plain membership, and scopes groups to it', async () => {
    await syncMembershipsImpl(
      db,
      userId,
      baseId({
        site: 'site-acme',
        orgMemberships: [{ orgId: 'ext-org', orgSlug: 'org', orgName: 'Org', role: 'admin' }],
      }),
    );
    const site = await db.query.sites.findFirst({ where: eq(sites.externalId, 'site-acme') });
    expect(site).toBeTruthy();
    // The synced user belongs to the site, but only as a plain member.
    const sm = await db.query.siteMembers.findFirst({ where: eq(siteMembers.userId, userId) });
    expect(sm?.role).toBe('member');
    // The org group created by the sync is scoped to the site.
    const org = await db.query.groups.findFirst({ where: eq(groups.externalId, 'ext-org') });
    expect(org?.siteId).toBe(site!.id);
  });

  it('leaves groups siteless when the identity carries no site', async () => {
    await syncMembershipsImpl(
      db,
      userId,
      baseId({ orgMemberships: [{ orgId: 'ext-o2', role: 'member' }] }),
    );
    const org = await db.query.groups.findFirst({ where: eq(groups.externalId, 'ext-o2') });
    expect(org?.siteId).toBeNull();
    expect(await db.query.sites.findMany()).toEqual([]);
  });
});

describe('buildAuthContextImpl site RBAC', () => {
  async function siteWithProject(role: string) {
    const site = await findOrCreateSiteImpl(db, { slug: 'acme', name: 'Acme' });
    const p = await insertProject(db, { identifier: 'a', siteId: site.id });
    await upsertSiteMemberImpl(db, site.id, userId, role);
    return { site, p };
  }

  it('site owner manages every project in the site', async () => {
    const { p } = await siteWithProject('owner');
    const c = await buildAuthContextImpl(db, userId);
    expect(hasPermission(c, p.id, 'delete_project')).toBe(true);
    expect(hasPermission(c, p.id, 'manage_members')).toBe(true);
  });

  it('site admin manages every project in the site', async () => {
    const { p } = await siteWithProject('admin');
    const c = await buildAuthContextImpl(db, userId);
    expect(hasPermission(c, p.id, 'edit_project')).toBe(true);
  });

  it('site member alone grants no project access', async () => {
    const { p } = await siteWithProject('member');
    const c = await buildAuthContextImpl(db, userId);
    expect(hasPermission(c, p.id, 'view_project')).toBe(false);
  });

  it('an unknown site role grants nothing (fail-closed)', async () => {
    const { p } = await siteWithProject('bogus');
    const c = await buildAuthContextImpl(db, userId);
    expect(hasPermission(c, p.id, 'view_project')).toBe(false);
  });

  it('does not leak across sites (member of A, owner of B)', async () => {
    const siteA = await findOrCreateSiteImpl(db, { slug: 'a', name: 'A' });
    const siteB = await findOrCreateSiteImpl(db, { slug: 'b', name: 'B' });
    const pA = await insertProject(db, { identifier: 'pa', siteId: siteA.id });
    const pB = await insertProject(db, { identifier: 'pb', siteId: siteB.id });
    await upsertSiteMemberImpl(db, siteA.id, userId, 'member'); // belongs only
    await upsertSiteMemberImpl(db, siteB.id, userId, 'owner'); // manages B
    const c = await buildAuthContextImpl(db, userId);
    expect(hasPermission(c, pA.id, 'view_project')).toBe(false); // no grant in A
    expect(hasPermission(c, pB.id, 'delete_project')).toBe(true); // full in B
  });

  it('unions site perms with project membership', async () => {
    // Site owner on the project's site PLUS a legacy project membership: the
    // user gets the union (site grant already covers it, but both paths run).
    const site = await findOrCreateSiteImpl(db, { slug: 'acme', name: 'Acme' });
    const p = await insertProject(db, { identifier: 'a', siteId: site.id });
    await addManager(db, userId, p.id);
    await upsertSiteMemberImpl(db, site.id, userId, 'owner');
    const c = await buildAuthContextImpl(db, userId);
    expect(hasPermission(c, p.id, 'manage_members')).toBe(true);
  });
});
