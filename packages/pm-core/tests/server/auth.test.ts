import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type TestDB,
  addManager,
  insertProject,
  insertUser,
  makeTestDb,
} from '../../src/testing/db';
import { makeTestEnv } from '../../src/testing/env';
import { primeJwks, signTestJwt } from '../../src/testing/jwt';
import { users } from '@allenlabs/pm-core/db/schema';
import { ForbiddenError, UnauthorizedError } from '@allenlabs/pm-core/lib/permissions';
import {
  buildAuthContextImpl,
  checkPermission,
  findOrCreateUserBySsoImpl,
  userFromSessionImpl,
} from '@allenlabs/pm-core/server/auth';
import { cookieHeader } from '@allenlabs/pm-core/server/session.server';
import { betterAuthAdapter } from '@allenlabs/pm-core/server/auth/adapters/better-auth';

let db: TestDB;

beforeEach(async () => {
  db = await makeTestDb();
  await primeJwks(makeTestEnv());
});

describe('buildAuthContextImpl', () => {
  it('collects permissions across memberships', async () => {
    const u = await insertUser(db);
    const p1 = await insertProject(db, { identifier: 'p1' });
    const p2 = await insertProject(db, { identifier: 'p2' });
    await addManager(db, u.id, p1.id);
    await addManager(db, u.id, p2.id);
    const ctx = await buildAuthContextImpl(db, u.id);
    expect(ctx.userId).toBe(u.id);
    expect(ctx.isAdmin).toBe(false);
    expect(ctx.permissionsByProject[p1.id]?.has('manage_members')).toBe(true);
    expect(ctx.permissionsByProject[p2.id]?.has('view_project')).toBe(true);
  });

  it('marks admins via the user row', async () => {
    const u = await insertUser(db, { admin: true });
    const ctx = await buildAuthContextImpl(db, u.id);
    expect(ctx.isAdmin).toBe(true);
  });

  it('throws Unauthorized when user is missing', async () => {
    await expect(buildAuthContextImpl(db, 9999)).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('skips the user lookup when passed a CurrentUser object', async () => {
    const u = await insertUser(db, { admin: true });
    const p1 = await insertProject(db, { identifier: 'cu1' });
    await addManager(db, u.id, p1.id);
    // Passing the already-known CurrentUser must take the no-DB-lookup branch:
    // userId + isAdmin come straight off the object, not from users.findFirst.
    const ctx = await buildAuthContextImpl(db, {
      id: u.id,
      login: u.login,
      email: u.email,
      firstname: u.firstname,
      lastname: u.lastname,
      isAdmin: true,
      avatarUrl: null,
    });
    expect(ctx.userId).toBe(u.id);
    expect(ctx.isAdmin).toBe(true);
    expect(ctx.permissionsByProject[p1.id]?.has('manage_members')).toBe(true);
  });

  it('derives per-project permissions from JWT team memberships', async () => {
    const u = await insertUser(db);
    const p = await insertProject(db, { identifier: 'team-p', authTeamId: 'team_abc' });
    const ctx = await buildAuthContextImpl(db, u.id, [
      { teamId: 'team_abc', role: 'maintainer' },
    ]);
    // maintainer → edit_project but not delete/manage_members.
    expect(ctx.permissionsByProject[p.id]?.has('view_project')).toBe(true);
    expect(ctx.permissionsByProject[p.id]?.has('edit_project')).toBe(true);
    expect(ctx.permissionsByProject[p.id]?.has('manage_members')).toBe(false);
  });

  it('reads team memberships off the passed CurrentUser', async () => {
    const u = await insertUser(db);
    const p = await insertProject(db, { identifier: 'team-cu', authTeamId: 'team_cu' });
    const ctx = await buildAuthContextImpl(db, {
      id: u.id,
      login: u.login,
      email: u.email,
      firstname: u.firstname,
      lastname: u.lastname,
      isAdmin: false,
      avatarUrl: null,
      teamMemberships: [{ teamId: 'team_cu', role: 'viewer' }],
    });
    expect(ctx.permissionsByProject[p.id]?.has('view_project')).toBe(true);
    expect(ctx.permissionsByProject[p.id]?.has('add_issues')).toBe(false);
  });

  it('unions team-derived perms with the legacy pm.members path', async () => {
    const u = await insertUser(db);
    const teamProject = await insertProject(db, { identifier: 'tp', authTeamId: 'team_x' });
    const legacyProject = await insertProject(db, { identifier: 'lp' });
    await addManager(db, u.id, legacyProject.id);
    const ctx = await buildAuthContextImpl(db, u.id, [
      { teamId: 'team_x', role: 'commenter' },
    ]);
    expect(ctx.permissionsByProject[teamProject.id]?.has('add_issues')).toBe(true);
    expect(ctx.permissionsByProject[legacyProject.id]?.has('manage_members')).toBe(true);
  });

  it('ignores team memberships whose team maps to no project', async () => {
    const u = await insertUser(db);
    const ctx = await buildAuthContextImpl(db, u.id, [
      { teamId: 'team_orphan', role: 'owner' },
    ]);
    expect(Object.keys(ctx.permissionsByProject)).toHaveLength(0);
  });
});

describe('checkPermission', () => {
  it('passes when permission is present', () => {
    const ctx = {
      userId: 1,
      isAdmin: false,
      permissionsByProject: { 1: new Set(['view_issues' as const]) },
    };
    expect(() => checkPermission(ctx, 1, 'view_issues')).not.toThrow();
  });

  it('throws Forbidden when permission missing', () => {
    const ctx = { userId: 1, isAdmin: false, permissionsByProject: {} };
    expect(() => checkPermission(ctx, 1, 'view_issues')).toThrow(ForbiddenError);
  });
});

describe('userFromSessionImpl', () => {
  it('returns null when cookie missing', async () => {
    expect(await userFromSessionImpl(db, betterAuthAdapter, makeTestEnv(), null)).toBeNull();
  });

  it('returns null when cookie present but token invalid', async () => {
    const env = makeTestEnv();
    expect(await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, 'not-a-real-jwt'))).toBeNull();
  });

  it('returns the user when JWT.sub matches better_auth_user_id', async () => {
    const u = await insertUser(db, { betterAuthUserId: 'ba-user-1' });
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'ba-user-1', email: u.email });
    const me = await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, token));
    expect(me?.id).toBe(u.id);
    expect(me?.login).toBe(u.login);
  });

  it('carries team memberships from the JWT onto the CurrentUser', async () => {
    await insertUser(db, { betterAuthUserId: 'ba-team' });
    const env = makeTestEnv();
    const token = await signTestJwt(env, {
      sub: 'ba-team',
      teamMemberships: [{ teamId: 'team_z', role: 'contributor' }],
    });
    const me = await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, token));
    expect(me?.teamMemberships).toEqual([{ teamId: 'team_z', role: 'contributor' }]);
  });

  it('syncs username/preferredName from the JWT when they changed', async () => {
    const u = await insertUser(db, { betterAuthUserId: 'ba-sync' });
    const env = makeTestEnv();
    const token = await signTestJwt(env, {
      sub: 'ba-sync',
      username: 'newhandle',
      preferredName: 'Preferred',
    });
    const me = await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, token));
    expect(me?.username).toBe('newhandle');
    expect(me?.preferredName).toBe('Preferred');
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, u.id) });
    expect(refreshed?.username).toBe('newhandle');
    expect(refreshed?.preferredName).toBe('Preferred');
  });

  it('syncs only the changed field, preserving the other', async () => {
    const u = await insertUser(db, {
      betterAuthUserId: 'ba-partial',
      username: 'keep',
      preferredName: 'KeepPreferred',
    });
    const env = makeTestEnv();
    // Only preferredName changes; username claim is absent (null) so the
    // existing username must be preserved via the `?? row.username` branch.
    const token = await signTestJwt(env, {
      sub: 'ba-partial',
      preferredName: 'ChangedPreferred',
    });
    const me = await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, token));
    expect(me?.username).toBe('keep');
    expect(me?.preferredName).toBe('ChangedPreferred');
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, u.id) });
    expect(refreshed?.username).toBe('keep');
    expect(refreshed?.preferredName).toBe('ChangedPreferred');
  });

  it('preserves preferredName when only username changes', async () => {
    const u = await insertUser(db, {
      betterAuthUserId: 'ba-uname-only',
      username: 'oldname',
      preferredName: 'StayPreferred',
    });
    const env = makeTestEnv();
    // Only username changes; preferredName claim is absent → keep existing.
    const token = await signTestJwt(env, {
      sub: 'ba-uname-only',
      username: 'newname',
    });
    const me = await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, token));
    expect(me?.username).toBe('newname');
    expect(me?.preferredName).toBe('StayPreferred');
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, u.id) });
    expect(refreshed?.preferredName).toBe('StayPreferred');
  });

  it('does not write when JWT profile fields already match', async () => {
    await insertUser(db, {
      betterAuthUserId: 'ba-nochange',
      username: 'same',
      preferredName: 'Same',
    });
    const env = makeTestEnv();
    const token = await signTestJwt(env, {
      sub: 'ba-nochange',
      username: 'same',
      preferredName: 'Same',
    });
    const me = await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, token));
    expect(me?.username).toBe('same');
    expect(me?.teamMemberships).toEqual([]);
  });

  it('returns null when JWT.sub has no matching better_auth_user_id', async () => {
    await insertUser(db, { betterAuthUserId: 'ba-user-1' });
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'unlinked-ba-user' });
    expect(await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, token))).toBeNull();
  });

  it('defaults teamMemberships to [] when the identity omits them', async () => {
    await insertUser(db, { betterAuthUserId: 'stub-sub' });
    // A stub adapter whose identity carries no teamMemberships → the `?? []`
    // default fires (the betterAuth adapter always supplies an array).
    const stub = {
      id: 'stub',
      verify: async () => ({ subject: 'stub-sub', email: '' }),
    } as unknown as Parameters<typeof userFromSessionImpl>[1];
    const me = await userFromSessionImpl(db, stub, makeTestEnv(), 'cookie');
    expect(me?.teamMemberships).toEqual([]);
  });

  it('returns null when the matched user is locked', async () => {
    await insertUser(db, { betterAuthUserId: 'ba-user-1', status: 'locked' });
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'ba-user-1' });
    expect(await userFromSessionImpl(db, betterAuthAdapter, env, cookieHeader(env, token))).toBeNull();
  });
});

describe('findOrCreateUserBySsoImpl', () => {
  it('returns the linked user when better_auth_user_id matches', async () => {
    const existing = await insertUser(db, { betterAuthUserId: 'linked-1' });
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'linked-1',
      email: 'unused@example.com',
    });
    expect(out.id).toBe(existing.id);
  });

  it('syncs username/preferredName onto a linked user', async () => {
    const existing = await insertUser(db, { betterAuthUserId: 'linked-sync' });
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'linked-sync',
      email: 'unused@example.com',
      username: 'synced',
      preferredName: 'Synced Name',
    });
    expect(out.id).toBe(existing.id);
    expect(out.username).toBe('synced');
    expect(out.preferredName).toBe('Synced Name');
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, existing.id) });
    expect(refreshed?.username).toBe('synced');
  });

  it('persists username/preferredName on a brand-new user', async () => {
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'new-with-profile',
      email: 'profile@example.com',
      displayName: 'Profile User',
      username: 'profileuser',
      preferredName: 'Prof',
    });
    expect(out.username).toBe('profileuser');
    expect(out.preferredName).toBe('Prof');
    expect(out.betterAuthUserId).toBe('new-with-profile');
  });

  it('backfills username/preferredName on an email-matched user', async () => {
    const existing = await insertUser(db, { email: 'bf@example.com' });
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'bf-uuid',
      email: 'bf@example.com',
      username: 'bfhandle',
      preferredName: 'BF',
    });
    expect(out.id).toBe(existing.id);
    expect(out.username).toBe('bfhandle');
    expect(out.preferredName).toBe('BF');
  });

  it('backfills the link onto an existing user matched by email', async () => {
    const existing = await insertUser(db, { email: 'migrating@example.com' });
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'fresh-uuid',
      email: 'Migrating@Example.Com',
      displayName: 'Mig User',
    });
    expect(out.id).toBe(existing.id);
    const refreshed = await db.query.users.findFirst({ where: eq(users.id, existing.id) });
    expect(refreshed?.betterAuthUserId).toBe('fresh-uuid');
  });

  it('creates a brand-new user with admin=true when none exist yet', async () => {
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'first-user',
      email: 'first@example.com',
      displayName: 'First User',
    });
    expect(out.email).toBe('first@example.com');
    expect(out.firstname).toBe('First');
    expect(out.lastname).toBe('User');
    expect(out.isAdmin).toBe(true);
  });

  it('creates a new user (non-admin) when other users already exist', async () => {
    await insertUser(db, { admin: true });
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'second-user',
      email: 'second@example.com',
    });
    expect(out.isAdmin).toBe(false);
  });

  it('dedupes the login when the email local-part is already taken', async () => {
    await insertUser(db, { login: 'taken', email: 'someone-else@example.com' });
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'sso-uuid',
      email: 'taken@example.com',
    });
    expect(out.login).toBe('taken1');
  });

  it('throws when the JWT has no email claim and the user is brand-new', async () => {
    await expect(
      findOrCreateUserBySsoImpl(db, { subject: 'no-email-uuid', email: '' }),
    ).rejects.toThrow(/email/);
  });

  it('falls back to "user" as the login base when the email local-part is all junk', async () => {
    // The email local-part contains only characters stripped by the
    // [^a-z0-9._-] regex, so `split('@')[0].replace(...)` returns ''
    // and the `|| 'user'` fallback fires.
    const out = await findOrCreateUserBySsoImpl(db, {
      subject: 'junk-local-part',
      email: '!!!@example.com',
    });
    expect(out.login).toBe('user');
  });
});
