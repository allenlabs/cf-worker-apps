import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type TestDB, addManager, insertProject, insertUser, makeTestDb } from '../../src/testing/db';
import { groupMembers, groups, projects } from '@allenlabs/pm-core/db/schema';
import { buildAuthContextImpl } from '@allenlabs/pm-core/server/auth';
import { hasPermission } from '@allenlabs/pm-core/lib/permissions';

let db: TestDB;
let userId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const u = await insertUser(db, { login: 'u', email: 'u@x.test' });
  userId = u.id;
});

async function makeGroup(
  slug: string,
  parentId: number | null = null,
  kind: 'organization' | 'team' = 'organization',
) {
  const [g] = await db.insert(groups).values({ slug, name: slug, parentId, kind }).returning();
  return g!;
}
async function attach(projectId: number, groupId: number) {
  await db.update(projects).set({ groupId }).where(eq(projects.id, projectId));
}
async function member(groupId: number, role: string) {
  await db.insert(groupMembers).values({ groupId, userId, role });
}
const ctx = () => buildAuthContextImpl(db, userId);

describe('buildAuthContextImpl group-tree inheritance', () => {
  it('membership on a deep ancestor grants a descendant project (3 levels)', async () => {
    const org = await makeGroup('acme'); // root
    const subOrg = await makeGroup('acme-eu', org.id); // level 2
    const team = await makeGroup('core', subOrg.id, 'team'); // level 3
    const p = await insertProject(db, { identifier: 'a' });
    await attach(p.id, team.id);
    await member(org.id, 'admin'); // member of the ROOT only
    const c = await ctx();
    // admin on the root → full perms on a project three levels down.
    expect(hasPermission(c, p.id, 'delete_project')).toBe(true);
    expect(hasPermission(c, p.id, 'manage_members')).toBe(true);
  });

  it('a "member" role grants contributor, not manager', async () => {
    const org = await makeGroup('acme');
    const p = await insertProject(db, { identifier: 'a' });
    await attach(p.id, org.id);
    await member(org.id, 'member');
    const c = await ctx();
    expect(hasPermission(c, p.id, 'add_issues')).toBe(true); // contributor
    expect(hasPermission(c, p.id, 'edit_project')).toBe(false);
    expect(hasPermission(c, p.id, 'delete_project')).toBe(false);
  });

  it('a "lead" on a mid-tree node manages its whole subtree', async () => {
    const org = await makeGroup('acme');
    const div = await makeGroup('div', org.id);
    const team = await makeGroup('squad', div.id, 'team');
    const p = await insertProject(db, { identifier: 'a' });
    await attach(p.id, team.id);
    await member(div.id, 'lead'); // lead on the middle node
    const c = await ctx();
    expect(hasPermission(c, p.id, 'edit_project')).toBe(true);
  });

  it('unions group + project membership (most-permissive)', async () => {
    const org = await makeGroup('acme');
    const p = await insertProject(db, { identifier: 'a' });
    await attach(p.id, org.id);
    await member(org.id, 'member'); // contributor from the group
    await addManager(db, userId, p.id); // manager from pm.members
    const c = await ctx();
    expect(hasPermission(c, p.id, 'add_issues')).toBe(true); // from group member
    expect(hasPermission(c, p.id, 'manage_members')).toBe(true); // from project manager
  });

  it('grants nothing for an unknown group role (fail-closed)', async () => {
    const org = await makeGroup('acme');
    const p = await insertProject(db, { identifier: 'a' });
    await attach(p.id, org.id);
    await member(org.id, 'bogus');
    const c = await ctx();
    expect(hasPermission(c, p.id, 'view_project')).toBe(false);
  });

  it('legacy NULL-group project is unchanged (needs pm.members)', async () => {
    const p = await insertProject(db, { identifier: 'legacy' }); // group_id NULL
    const none = await ctx();
    expect(hasPermission(none, p.id, 'view_project')).toBe(false);
    await addManager(db, userId, p.id);
    const c = await ctx();
    expect(hasPermission(c, p.id, 'manage_members')).toBe(true);
  });

  it('tolerates a pre-existing parent cycle without hanging', async () => {
    const a = await makeGroup('a');
    const b = await makeGroup('b', a.id);
    // Force a cycle a→b→a directly in the data (bypassing the impl guard).
    await db.update(groups).set({ parentId: b.id }).where(eq(groups.id, a.id));
    const p = await insertProject(db, { identifier: 'cyc' });
    await attach(p.id, a.id);
    await member(b.id, 'owner'); // member of the ancestor inside the cycle
    const c = await ctx();
    // Walk a → b (owner → full) → a (seen) break. Resolves + terminates.
    expect(hasPermission(c, p.id, 'delete_project')).toBe(true);
  });
});
