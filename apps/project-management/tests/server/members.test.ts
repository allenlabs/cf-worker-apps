import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { type TestDB, addManager, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { members, roles } from '@allenlabs/pm-core/db/schema';
import {
  addMemberImpl,
  changeMemberRoleImpl,
  inviteMemberImpl,
  listAllUsersImpl,
  listMembersImpl,
  listRolesImpl,
  loadTeamMembersImpl,
  removeMemberImpl,
  removeTeamMemberImpl,
  setTeamMemberRoleImpl,
  teamIdForProjectImpl,
} from '~/server/members';

const ORG_ENV = {
  AUTH_API_URL: 'https://auth-api.test',
  PM_ORG_HMAC_CLIENT_ID: 'pm',
  PM_ORG_HMAC_SECRET: 'test-org-hmac-secret-1234567890abcd',
};

function jsonFetcher(payload: unknown, capture?: (url: string, init: RequestInit) => void) {
  return vi.fn(async (url: string, init: RequestInit) => {
    capture?.(url, init);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

let db: TestDB;

beforeEach(async () => {
  db = await makeTestDb();
});

describe('member impls', () => {
  it('listRolesImpl returns the three seeded roles ordered by position', async () => {
    const rs = await listRolesImpl(db);
    expect(rs.map((r) => r.name)).toEqual(['Manager', 'Developer', 'Reporter']);
  });

  it('listAllUsersImpl excludes locked users', async () => {
    const a = await insertUser(db, { login: 'a', email: 'a@x' });
    await insertUser(db, { login: 'b', email: 'b@x', status: 'locked' });
    const users = await listAllUsersImpl(db);
    expect(users.map((u) => u.login)).toEqual(['a']);
    expect(users[0]!.id).toBe(a.id);
  });

  it('addMemberImpl is idempotent for the same triple', async () => {
    const u = await insertUser(db);
    const p = await insertProject(db);
    const dev = (await listRolesImpl(db)).find((r) => r.name === 'Developer')!;
    await addMemberImpl(db, { userId: u.id, projectId: p.id, roleId: dev.id });
    await addMemberImpl(db, { userId: u.id, projectId: p.id, roleId: dev.id });
    const rows = await db.query.members.findMany({ where: eq(members.userId, u.id) });
    expect(rows).toHaveLength(1);
  });

  it('listMembersImpl returns join data with role names', async () => {
    const u = await insertUser(db, { login: 'manager' });
    const p = await insertProject(db);
    await addManager(db, u.id, p.id);
    const rows = await listMembersImpl(db, p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.login).toBe('manager');
    expect(rows[0]!.roleName).toBe('Manager');
  });

  it('changeMemberRoleImpl updates only the target member', async () => {
    const u = await insertUser(db);
    const p = await insertProject(db);
    await addManager(db, u.id, p.id);
    const m = (await listMembersImpl(db, p.id))[0]!;
    const dev = (await listRolesImpl(db)).find((r) => r.name === 'Developer')!;
    await changeMemberRoleImpl(db, m.id, dev.id);
    const updated = await db.query.members.findFirst({ where: eq(members.id, m.id) });
    expect(updated!.roleId).toBe(dev.id);
  });

  it('removeMemberImpl deletes the row', async () => {
    const u = await insertUser(db);
    const p = await insertProject(db);
    await addManager(db, u.id, p.id);
    const m = (await listMembersImpl(db, p.id))[0]!;
    await removeMemberImpl(db, m.id);
    expect(await db.query.members.findFirst({ where: eq(members.id, m.id) })).toBeUndefined();
  });
});

describe('team-backed member impls (Phase 2)', () => {
  it('teamIdForProjectImpl returns the project team id or null', async () => {
    const withTeam = await insertProject(db, { identifier: 'wt', authTeamId: 'team_wt' });
    const without = await insertProject(db, { identifier: 'wo' });
    expect(await teamIdForProjectImpl(db, withTeam.id)).toBe('team_wt');
    expect(await teamIdForProjectImpl(db, without.id)).toBeNull();
    expect(await teamIdForProjectImpl(db, 99999)).toBeNull();
  });

  it('loadTeamMembersImpl returns an empty roster when no team is linked', async () => {
    const p = await insertProject(db, { identifier: 'noteam' });
    const fetcher = jsonFetcher({ members: [], invitations: [] });
    const out = await loadTeamMembersImpl(db, ORG_ENV, p.id, { fetcher });
    expect(out).toEqual({ teamId: null, members: [], invitations: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('loadTeamMembersImpl fetches the roster for a linked team', async () => {
    const p = await insertProject(db, { identifier: 'hasteam', authTeamId: 'team_h' });
    let url = '';
    const fetcher = jsonFetcher(
      {
        members: [
          { userId: 'u1', email: 'a@b', name: 'A', username: 'a', preferredName: null, role: 'owner' },
        ],
        invitations: [{ id: 'i1', email: 'p@e', role: 'viewer', status: 'pending', expiresAt: 'x' }],
      },
      (u) => {
        url = u;
      },
    );
    const out = await loadTeamMembersImpl(db, ORG_ENV, p.id, { fetcher });
    expect(out.teamId).toBe('team_h');
    expect(out.members).toHaveLength(1);
    expect(out.invitations).toHaveLength(1);
    expect(url).toContain('teamId=team_h');
  });

  it('inviteMemberImpl forwards to the org bridge with the resolved team id', async () => {
    const p = await insertProject(db, { identifier: 'inv', authTeamId: 'team_i' });
    let body = '';
    const fetcher = jsonFetcher({ ok: true, invitationId: 'inv99', via: 'api' }, (_u, init) => {
      body = init.body as string;
    });
    const out = await inviteMemberImpl(
      db,
      ORG_ENV,
      { actingUserId: 'acting', projectId: p.id, email: 'new@x.com', role: 'commenter' },
      { fetcher },
    );
    expect(out.invitationId).toBe('inv99');
    expect(JSON.parse(body)).toMatchObject({ teamId: 'team_i', email: 'new@x.com', role: 'commenter' });
  });

  it('inviteMemberImpl throws when the project has no team', async () => {
    const p = await insertProject(db, { identifier: 'inv-noteam' });
    const fetcher = jsonFetcher({});
    await expect(
      inviteMemberImpl(db, ORG_ENV, { actingUserId: 'a', projectId: p.id, email: 'x@y', role: 'viewer' }, { fetcher }),
    ).rejects.toThrow(/no collaboration team/);
  });

  it('setTeamMemberRoleImpl forwards the new role', async () => {
    const p = await insertProject(db, { identifier: 'sr', authTeamId: 'team_s' });
    let body = '';
    const fetcher = jsonFetcher({ ok: true, userId: 'u2', role: 'maintainer' }, (_u, init) => {
      body = init.body as string;
    });
    const out = await setTeamMemberRoleImpl(
      db,
      ORG_ENV,
      { actingUserId: 'a', projectId: p.id, targetUserId: 'u2', role: 'maintainer' },
      { fetcher },
    );
    expect(out).toEqual({ ok: true });
    expect(JSON.parse(body)).toMatchObject({ teamId: 'team_s', targetUserId: 'u2', role: 'maintainer' });
  });

  it('setTeamMemberRoleImpl throws without a team', async () => {
    const p = await insertProject(db, { identifier: 'sr-noteam' });
    await expect(
      setTeamMemberRoleImpl(db, ORG_ENV, { actingUserId: 'a', projectId: p.id, targetUserId: 'u', role: 'viewer' }, { fetcher: jsonFetcher({}) }),
    ).rejects.toThrow(/no collaboration team/);
  });

  it('removeTeamMemberImpl forwards the target user id', async () => {
    const p = await insertProject(db, { identifier: 'rm', authTeamId: 'team_r' });
    let body = '';
    const fetcher = jsonFetcher({ ok: true, userId: 'u3' }, (_u, init) => {
      body = init.body as string;
    });
    const out = await removeTeamMemberImpl(
      db,
      ORG_ENV,
      { actingUserId: 'a', projectId: p.id, targetUserId: 'u3' },
      { fetcher },
    );
    expect(out).toEqual({ ok: true });
    expect(JSON.parse(body)).toMatchObject({ teamId: 'team_r', targetUserId: 'u3' });
  });

  it('removeTeamMemberImpl throws without a team', async () => {
    const p = await insertProject(db, { identifier: 'rm-noteam' });
    await expect(
      removeTeamMemberImpl(db, ORG_ENV, { actingUserId: 'a', projectId: p.id, targetUserId: 'u' }, { fetcher: jsonFetcher({}) }),
    ).rejects.toThrow(/no collaboration team/);
  });
});
