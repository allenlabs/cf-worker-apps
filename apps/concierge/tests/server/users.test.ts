import { describe, expect, it } from 'vitest';
import { insertPmUser, makeTestDb } from '../_setup/db';
import { findUserBySsoImpl } from '~/server/users';

describe('findUserBySsoImpl', () => {
  it('round-trips a JWT sub → pm.users row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'carol', sub: 'sso-carol' });
    const found = await findUserBySsoImpl(db, 'sso-carol');
    expect(found?.id).toBe(u.id);
    expect(found?.login).toBe('carol');
    expect(found?.isAdmin).toBe(false);
  });

  it('returns null when no row maps the sub', async () => {
    const db = await makeTestDb();
    expect(await findUserBySsoImpl(db, 'unknown')).toBeNull();
  });
});
