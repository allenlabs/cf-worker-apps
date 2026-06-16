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
import {
  findOrCreateSiteImpl,
  isSiteRole,
  listSiteMembersImpl,
  listSitesImpl,
  removeSiteMemberAsImpl,
  removeSiteMemberImpl,
  setSiteMemberRoleAsImpl,
  setSiteMemberRoleImpl,
  upsertSiteMemberImpl,
} from '@allenlabs/pm-core/server/sites';
import { canManageSiteRole } from '@allenlabs/pm-core/lib/permissions';
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

describe('site administration impls', () => {
  it('lists sites ordered by slug', async () => {
    await findOrCreateSiteImpl(db, { slug: 'zeta', name: 'Z' });
    await findOrCreateSiteImpl(db, { slug: 'alpha', name: 'A' });
    const rows = await listSitesImpl(db);
    expect(rows.map((s) => s.slug)).toEqual(['alpha', 'zeta']);
  });

  it('validates assignable roles', () => {
    expect(isSiteRole('owner')).toBe(true);
    expect(isSiteRole('admin')).toBe(true);
    expect(isSiteRole('member')).toBe(true);
    expect(isSiteRole('superuser')).toBe(false);
  });

  it('setSiteMemberRoleImpl grants a role and rejects an unknown one', async () => {
    const site = await findOrCreateSiteImpl(db, { slug: 'acme', name: 'Acme' });
    await setSiteMemberRoleImpl(db, site.id, userId, 'owner'); // service-admin grant
    const members = await listSiteMembersImpl(db, site.id);
    expect(members).toEqual([{ userId, login: 'u', email: 'u@x.test', role: 'owner' }]);
    // A typo can't silently create a no-perms grant.
    await expect(
      setSiteMemberRoleImpl(db, site.id, userId, 'superuser' as never),
    ).rejects.toThrow(/Unknown site role/);
  });

  it('removeSiteMemberImpl revokes the grant', async () => {
    const site = await findOrCreateSiteImpl(db, { slug: 'acme', name: 'Acme' });
    await setSiteMemberRoleImpl(db, site.id, userId, 'admin');
    await removeSiteMemberImpl(db, site.id, userId);
    expect(await listSiteMembersImpl(db, site.id)).toEqual([]);
  });
});

describe('canManageSiteRole (delegated policy)', () => {
  it('owner manages owners; admin tops out at admin', () => {
    // owner can do everything
    expect(canManageSiteRole('owner', 'owner', 'owner')).toBe(true);
    expect(canManageSiteRole('owner', null, 'member')).toBe(true);
    // admin manages admin + member, but never owners
    expect(canManageSiteRole('admin', 'admin', 'admin')).toBe(true);
    expect(canManageSiteRole('admin', null, 'member')).toBe(true);
    expect(canManageSiteRole('admin', 'admin', 'owner')).toBe(false); // can't grant owner
    expect(canManageSiteRole('admin', 'owner', 'member')).toBe(false); // can't touch an owner
    // members + non-members manage no one
    expect(canManageSiteRole('member', null, 'member')).toBe(false);
    expect(canManageSiteRole(null, null, 'member')).toBe(false);
    // removal (newRole = null) only checks the current-role rung
    expect(canManageSiteRole('owner', 'admin', null)).toBe(true);
    expect(canManageSiteRole('admin', 'owner', null)).toBe(false);
  });
});

describe('delegated site administration impls', () => {
  let site: { id: number };
  let owner: number;
  let admin: number;
  let target: number;

  beforeEach(async () => {
    site = await findOrCreateSiteImpl(db, { slug: 'acme', name: 'Acme' });
    owner = userId; // the user seeded in the outer beforeEach
    admin = (await insertUser(db, { login: 'adm', email: 'adm@x.test' })).id;
    target = (await insertUser(db, { login: 'tgt', email: 'tgt@x.test' })).id;
    await upsertSiteMemberImpl(db, site.id, owner, 'owner');
    await upsertSiteMemberImpl(db, site.id, admin, 'admin');
  });

  const roleOf = async (uid: number) =>
    (await listSiteMembersImpl(db, site.id)).find((m) => m.userId === uid)?.role;

  it('an owner can add/promote another owner', async () => {
    await setSiteMemberRoleAsImpl(db, { siteId: site.id, actorUserId: owner, targetUserId: target, role: 'owner' });
    expect(await roleOf(target)).toBe('owner');
  });

  it('an admin can add an admin/member but cannot mint an owner', async () => {
    await setSiteMemberRoleAsImpl(db, { siteId: site.id, actorUserId: admin, targetUserId: target, role: 'admin' });
    expect(await roleOf(target)).toBe('admin');
    await expect(
      setSiteMemberRoleAsImpl(db, { siteId: site.id, actorUserId: admin, targetUserId: target, role: 'owner' }),
    ).rejects.toThrow(/Insufficient site role/);
  });

  it('an admin cannot modify or evict an owner', async () => {
    await expect(
      setSiteMemberRoleAsImpl(db, { siteId: site.id, actorUserId: admin, targetUserId: owner, role: 'member' }),
    ).rejects.toThrow(/Insufficient site role/);
    await expect(
      removeSiteMemberAsImpl(db, { siteId: site.id, actorUserId: admin, targetUserId: owner }),
    ).rejects.toThrow(/Insufficient site role/);
    expect(await roleOf(owner)).toBe('owner'); // untouched
  });

  it('an owner can evict an admin', async () => {
    await removeSiteMemberAsImpl(db, { siteId: site.id, actorUserId: owner, targetUserId: admin });
    expect(await roleOf(admin)).toBeUndefined();
  });

  it('a non-member actor is forbidden', async () => {
    await expect(
      setSiteMemberRoleAsImpl(db, { siteId: site.id, actorUserId: target, targetUserId: admin, role: 'member' }),
    ).rejects.toThrow(/Insufficient site role/);
  });

  it('rejects an unknown role string', async () => {
    await expect(
      setSiteMemberRoleAsImpl(db, { siteId: site.id, actorUserId: owner, targetUserId: target, role: 'root' as never }),
    ).rejects.toThrow(/Unknown site role/);
  });

  it('treats a junk stored role as "not a member" (an owner can re-set it)', async () => {
    await upsertSiteMemberImpl(db, site.id, target, 'bogus'); // junk current role
    await setSiteMemberRoleAsImpl(db, { siteId: site.id, actorUserId: owner, targetUserId: target, role: 'member' });
    expect(await roleOf(target)).toBe('member');
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
