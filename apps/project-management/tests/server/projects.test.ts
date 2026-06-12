import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  type TestDB,
  insertProject,
  insertUser,
  makeTestDb,
  addManager,
} from '../_setup/db';
import {
  enabledModules,
  issueCategories,
  members,
  projects,
  projectTrackers,
  versions,
  wikis,
} from '~/db/schema';
import { type AuthContext, type Permission } from '~/lib/permissions';
import { type CurrentUser } from '~/server/auth';
import {
  createProjectImpl,
  deleteProjectImpl,
  extractRows,
  getProjectImpl,
  listProjectsImpl,
  updateProjectImpl,
} from '~/server/projects';

let db: TestDB;

beforeEach(async () => {
  db = await makeTestDb();
});

function makeUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return {
    id: 1,
    login: 'alice',
    email: 'alice@x.test',
    firstname: '',
    lastname: '',
    isAdmin: false,
    avatarUrl: null,
    ...overrides,
  };
}

function makeCtx(perms: Record<number, Permission[]> = {}, isAdmin = false): AuthContext {
  const permissionsByProject: AuthContext['permissionsByProject'] = {};
  for (const [pid, list] of Object.entries(perms)) {
    permissionsByProject[Number(pid)] = new Set(list);
  }
  return { userId: 1, isAdmin, permissionsByProject };
}

describe('listProjectsImpl', () => {
  it('shows only active+public projects to unauthenticated', async () => {
    await insertProject(db, { identifier: 'open', name: 'Open', isPublic: true });
    await insertProject(db, { identifier: 'private', name: 'Private', isPublic: false });
    await insertProject(db, {
      identifier: 'closed-public',
      name: 'Closed',
      isPublic: true,
      status: 'closed',
    });
    const list = await listProjectsImpl(db, null, null);
    expect(list.map((p) => p.identifier)).toEqual(['open']);
  });

  it('shows everything to admin', async () => {
    await insertProject(db, { identifier: 'a' });
    await insertProject(db, { identifier: 'b' });
    const list = await listProjectsImpl(db, makeUser({ isAdmin: true }), null);
    expect(list).toHaveLength(2);
  });

  it('shows public + member projects to a regular user', async () => {
    const u = await insertUser(db);
    const pub = await insertProject(db, { identifier: 'pub', isPublic: true });
    const member = await insertProject(db, { identifier: 'member', isPublic: false });
    await insertProject(db, { identifier: 'other', isPublic: false });
    await addManager(db, u.id, member.id);
    const list = await listProjectsImpl(
      db,
      makeUser({ id: u.id }),
      makeCtx({ [member.id]: ['view_project'] }),
    );
    expect(list.map((p) => p.identifier).sort()).toEqual(['member', 'pub']);
  });
});

describe('extractRows (driver shape normalizer)', () => {
  it('returns the array when postgres.js hands back a Result array', () => {
    const rows = [{ a: 1 }, { a: 2 }];
    expect(extractRows(rows)).toBe(rows);
  });

  it('unwraps drizzle-orm/pglite { rows } shape', () => {
    const rows = [{ a: 1 }];
    expect(extractRows({ rows })).toBe(rows);
  });

  it('returns [] for unexpected shapes', () => {
    expect(extractRows(null)).toEqual([]);
    expect(extractRows({})).toEqual([]);
    expect(extractRows({ rows: 'not-an-array' })).toEqual([]);
  });
});

describe('getProjectImpl', () => {
  it('returns hydrated data for a public project (anonymous)', async () => {
    const p = await insertProject(db, { isPublic: true });
    const result = await getProjectImpl(db, null, null, p.identifier);
    expect(result.id).toBe(p.id);
    expect(result.key).toBe(p.key); // key flows through the hydration CTE
    expect(result.trackers.length).toBeGreaterThan(0); // seeded + project_trackers
    expect(result.counts.openIssues).toBe(0);
    expect(result.counts.closedIssues).toBe(0);
    expect(result.activities).toEqual([]);
  });

  it('throws Project not found for unknown identifier', async () => {
    await expect(getProjectImpl(db, null, null, 'nope')).rejects.toThrow(/not found/);
  });

  it('throws Unauthorized for private project when anonymous', async () => {
    const p = await insertProject(db, { isPublic: false });
    await expect(getProjectImpl(db, null, null, p.identifier)).rejects.toThrow();
  });

  it('throws Forbidden for private project when user lacks view_project', async () => {
    const p = await insertProject(db, { isPublic: false });
    await expect(
      getProjectImpl(db, makeUser(), makeCtx(), p.identifier),
    ).rejects.toThrow();
  });

  it('returns data for member with view_project', async () => {
    const p = await insertProject(db, { isPublic: false });
    const r = await getProjectImpl(
      db,
      makeUser(),
      makeCtx({ [p.id]: ['view_project'] }),
      p.identifier,
    );
    expect(r.id).toBe(p.id);
  });

  it('allows admin to read private projects', async () => {
    const p = await insertProject(db, { isPublic: false });
    const r = await getProjectImpl(db, makeUser({ isAdmin: true }), null, p.identifier);
    expect(r.id).toBe(p.id);
  });

  it('reflects enabled modules + versions + categories after createProjectImpl', async () => {
    const u = await insertUser(db);
    const created = await createProjectImpl(db, makeUser({ id: u.id, login: u.login }), {
      identifier: 'full-flow',
      name: 'Full Flow',
      description: '',
      homepage: '',
      isPublic: true,
    });
    // Seed a version + category so the version/category mapping branches
    // in getProjectImpl get exercised (otherwise the .map callbacks stay
    // uncovered).
    await db.insert(versions).values({
      projectId: created.id,
      name: 'v1.0',
      description: 'first release',
      status: 'open',
      dueDate: '2026-12-31',
    });
    await db.insert(issueCategories).values({
      projectId: created.id,
      name: 'Bug',
    });
    const r = await getProjectImpl(db, null, null, created.identifier);
    expect(r.modules.sort()).toEqual([
      'files', 'gantt', 'issue_tracking', 'roadmap', 'time_tracking', 'wiki',
    ]);
    expect(r.trackers.length).toBeGreaterThan(0);
    expect(r.versions).toHaveLength(1);
    expect(r.versions[0]!.name).toBe('v1.0');
    expect(r.versions[0]!.createdAt).toBeInstanceOf(Date);
    expect(r.categories).toHaveLength(1);
    expect(r.categories[0]!.name).toBe('Bug');
  });
});

describe('createProjectImpl', () => {
  it('creates project, enables default modules + trackers, makes creator Manager', async () => {
    const u = await insertUser(db, { login: 'creator' });
    const created = await createProjectImpl(db, makeUser({ id: u.id, login: 'creator' }), {
      identifier: 'new-thing',
      name: 'New Thing',
      description: 'desc',
      homepage: '',
      isPublic: false,
    });
    expect(created.identifier).toBe('new-thing');

    const mods = await db.query.enabledModules.findMany({
      where: eq(enabledModules.projectId, created.id),
    });
    expect(mods.map((m) => m.name).sort()).toEqual([
      'files',
      'gantt',
      'issue_tracking',
      'roadmap',
      'time_tracking',
      'wiki',
    ]);

    const memberships = await db
      .select()
      .from(members)
      .where(eq(members.projectId, created.id));
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.userId).toBe(u.id);

    const wiki = await db.query.wikis.findFirst({ where: eq(wikis.projectId, created.id) });
    expect(wiki).toBeDefined();

    const pts = await db
      .select()
      .from(projectTrackers)
      .where(eq(projectTrackers.projectId, created.id));
    expect(pts.length).toBe(4); // 4 seeded trackers
  });

  it('rejects duplicate identifier', async () => {
    await insertProject(db, { identifier: 'dupe' });
    await expect(
      createProjectImpl(db, makeUser(), {
        identifier: 'dupe',
        name: 'X',
        description: '',
        homepage: '',
        isPublic: false,
      }),
    ).rejects.toThrow(/already used/);
  });

  it('derives a project key from the identifier when none is given', async () => {
    const u = await insertUser(db);
    const created = await createProjectImpl(db, makeUser({ id: u.id, login: u.login }), {
      identifier: 'redmine',
      name: 'Redmine',
      description: '',
      homepage: '',
      isPublic: false,
    });
    expect(created.key).toBe('REDMI'); // uppercase alnum, capped at 5
    expect(created.issueSeq).toBe(0);
  });

  it('accepts an explicit key and uppercases it', async () => {
    const u = await insertUser(db);
    const created = await createProjectImpl(db, makeUser({ id: u.id, login: u.login }), {
      identifier: 'redmine',
      key: 'red',
      name: 'Redmine',
      description: '',
      homepage: '',
      isPublic: false,
    });
    expect(created.key).toBe('RED');
  });

  it('rejects an invalid key shape', async () => {
    await expect(
      createProjectImpl(db, makeUser(), {
        identifier: 'bad-key',
        key: '1!!',
        name: 'X',
        description: '',
        homepage: '',
        isPublic: false,
      }),
    ).rejects.toThrow(/Invalid project key/);
  });

  it('rejects a duplicate key', async () => {
    await insertProject(db, { identifier: 'first', key: 'RED' });
    await expect(
      createProjectImpl(db, makeUser(), {
        identifier: 'second',
        key: 'RED',
        name: 'X',
        description: '',
        homepage: '',
        isPublic: false,
      }),
    ).rejects.toThrow(/key "RED" is already used/);
  });

  it('writes a project_created activity', async () => {
    await insertUser(db);
    const created = await createProjectImpl(db, makeUser({ login: 'alice' }), {
      identifier: 'a-proj',
      name: 'A',
      description: '',
      homepage: '',
      isPublic: false,
    });
    const act = await db.query.activities.findFirst();
    expect(act?.kind).toBe('project_created');
    expect(act?.title).toContain('alice');
    expect(act?.refId).toBe(created.id);
  });

  it('skips tracker enabling when no trackers seeded', async () => {
    const { trackers } = await import('~/db/schema');
    await db.delete(trackers);
    const u = await insertUser(db);
    const created = await createProjectImpl(db, makeUser({ id: u.id, login: u.login }), {
      identifier: 'no-trackers',
      name: 'X',
      description: '',
      homepage: '',
      isPublic: false,
    });
    expect(created.identifier).toBe('no-trackers');
  });

  it('skips manager assignment when Manager role missing', async () => {
    const { roles } = await import('~/db/schema');
    await db.delete(roles);
    const u = await insertUser(db);
    const created = await createProjectImpl(db, makeUser({ id: u.id, login: u.login }), {
      identifier: 'no-roles',
      name: 'X',
      description: '',
      homepage: '',
      isPublic: false,
    });
    expect(created.identifier).toBe('no-roles');
    const ms = await db.query.members.findMany();
    expect(ms).toHaveLength(0);
  });

  it('stores the provision hook teamId and passes a project-created context', async () => {
    const u = await insertUser(db, { betterAuthUserId: 'ba-creator' });
    let seen: { actingExternalUserId: string | null; projectName: string; projectSlug: string } | null = null;
    const created = await createProjectImpl(
      db,
      makeUser({ id: u.id, login: u.login, betterAuthUserId: 'ba-creator' }),
      { identifier: 'team-proj', name: 'Team Proj', description: '', homepage: '', isPublic: false },
      async (ctx) => {
        seen = ctx;
        return { teamId: 'team_new' };
      },
    );
    expect(created.authTeamId).toBe('team_new');
    expect(seen).toMatchObject({
      actingExternalUserId: 'ba-creator',
      projectName: 'Team Proj',
      projectSlug: 'team-proj',
    });
  });

  it('stores a null team id when the provision hook returns null', async () => {
    const u = await insertUser(db, { betterAuthUserId: 'ba-fail' });
    const created = await createProjectImpl(
      db,
      makeUser({ id: u.id, login: u.login, betterAuthUserId: 'ba-fail' }),
      { identifier: 'team-fail', name: 'Team Fail', description: '', homepage: '', isPublic: false },
      async () => ({ teamId: null }),
    );
    expect(created.authTeamId).toBeNull();
  });

  it('passes a null actingExternalUserId when the creator has no external id', async () => {
    const u = await insertUser(db);
    let seen: { actingExternalUserId: string | null } | null = null;
    await createProjectImpl(
      db,
      makeUser({ id: u.id, login: u.login, betterAuthUserId: null }),
      { identifier: 'no-ext', name: 'No Ext', description: '', homepage: '', isPublic: false },
      async (ctx) => {
        seen = ctx;
        return { teamId: null };
      },
    );
    expect(seen?.actingExternalUserId).toBeNull();
  });

  it('creates with pm.members RBAC (null team) when no provision hook is given', async () => {
    const u = await insertUser(db);
    const created = await createProjectImpl(
      db,
      makeUser({ id: u.id, login: u.login }),
      { identifier: 'no-prov', name: 'No Prov', description: '', homepage: '', isPublic: false },
    );
    expect(created.authTeamId).toBeNull();
    const ms = await db.query.members.findMany();
    expect(ms).toHaveLength(1); // creator added as Manager
  });
});

describe('updateProjectImpl', () => {
  it('updates mutable fields', async () => {
    const p = await insertProject(db);
    const updated = await updateProjectImpl(db, {
      id: p.id,
      name: 'Renamed',
      description: 'new desc',
      homepage: 'https://example.com',
      isPublic: true,
      status: 'closed',
    });
    expect(updated.name).toBe('Renamed');
    expect(updated.status).toBe('closed');
    expect(updated.isPublic).toBe(true);
  });

  it('throws when project missing', async () => {
    await expect(
      updateProjectImpl(db, {
        id: 99999,
        name: 'x',
        description: '',
        homepage: '',
        isPublic: false,
        status: 'active',
      }),
    ).rejects.toThrow(/not found/);
  });
});

describe('deleteProjectImpl', () => {
  it('removes the project row', async () => {
    const p = await insertProject(db);
    await deleteProjectImpl(db, p.id);
    expect(await db.query.projects.findFirst({ where: eq(projects.id, p.id) })).toBeUndefined();
  });
});
