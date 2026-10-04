import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  _testing,
  createApiClientImpl,
  createApiClientSchema,
  deleteApiClientImpl,
  findApiClientImpl,
  getCurrentIntentImpl,
  listApiClientsImpl,
  listHistoryImpl,
  loadHomeImpl,
  setIntentImpl,
  setIntentSchema,
} from '~/server/intent';
import { findUserBySsoImpl } from '~/server/users';

describe('setIntentSchema', () => {
  it('accepts a string', () => {
    expect(setIntentSchema.safeParse({ text: 'hello' }).success).toBe(true);
  });
  it('accepts empty string', () => {
    expect(setIntentSchema.safeParse({ text: '' }).success).toBe(true);
  });
  it('rejects > 280 chars', () => {
    expect(setIntentSchema.safeParse({ text: 'x'.repeat(281) }).success).toBe(false);
  });
  it('rejects non-string', () => {
    expect(setIntentSchema.safeParse({ text: 42 }).success).toBe(false);
  });
});

describe('setIntentImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts when no prior row', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await setIntentImpl(db, userId, { text: 'reviewing PRs' }, now);
    expect(r.text).toBe('reviewing PRs');
    expect(r.updatedAt).toBe('2026-05-24T10:00:00.000Z');
  });

  it('overwrites the same row (single primary key)', async () => {
    const t0 = new Date('2026-05-24T10:00:00Z');
    const t1 = new Date('2026-05-24T11:00:00Z');
    await setIntentImpl(db, userId, { text: 'first' }, t0);
    const second = await setIntentImpl(db, userId, { text: 'second' }, t1);
    expect(second.text).toBe('second');
    expect(second.updatedAt).toBe(t1.toISOString());
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM intent.current WHERE user_id = ${userId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { c: number }).c).toBe(1);
  });

  it('appends to history on every save', async () => {
    const t0 = new Date('2026-05-24T10:00:00Z');
    const t1 = new Date('2026-05-24T11:00:00Z');
    await setIntentImpl(db, userId, { text: 'first' }, t0);
    await setIntentImpl(db, userId, { text: 'second' }, t1);
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM intent.history WHERE user_id = ${userId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { c: number }).c).toBe(2);
  });

  it('per-user isolation', async () => {
    const other = await insertPmUser(db, { login: 'bob', sub: 'sso-b' });
    await setIntentImpl(db, userId, { text: 'mine' });
    await setIntentImpl(db, other.id, { text: 'theirs' });
    const mine = await getCurrentIntentImpl(db, userId);
    const theirs = await getCurrentIntentImpl(db, other.id);
    expect(mine.text).toBe('mine');
    expect(theirs.text).toBe('theirs');
  });
});

describe('getCurrentIntentImpl', () => {
  it('returns empty when no row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const r = await getCurrentIntentImpl(db, u.id);
    expect(r.text).toBe('');
    expect(r.updatedAt).toBe('');
  });
  it('returns the saved row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await setIntentImpl(db, u.id, { text: 'hello' }, now);
    const r = await getCurrentIntentImpl(db, u.id);
    expect(r.text).toBe('hello');
    expect(r.updatedAt).toBe(now.toISOString());
  });
});

describe('listHistoryImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    userId = u.id;
    const base = new Date('2026-05-24T10:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      await setIntentImpl(db, userId, { text: `step ${i}` }, new Date(base + i * 60_000));
    }
  });

  it('returns history DESC by set_at', async () => {
    const list = await listHistoryImpl(db, userId);
    expect(list.length).toBe(5);
    expect(list[0]!.text).toBe('step 4');
    expect(list[4]!.text).toBe('step 0');
  });

  it('respects limit', async () => {
    const list = await listHistoryImpl(db, userId, 2);
    expect(list.length).toBe(2);
    expect(list[0]!.text).toBe('step 4');
    expect(list[1]!.text).toBe('step 3');
  });

  it('clamps limit to [1, 500]', async () => {
    expect((await listHistoryImpl(db, userId, 0)).length).toBe(1);
    expect((await listHistoryImpl(db, userId, -5)).length).toBe(1);
    expect((await listHistoryImpl(db, userId, 9999)).length).toBe(5);
  });

  it('per-user scoping', async () => {
    const other = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    expect((await listHistoryImpl(db, other.id)).length).toBe(0);
  });

  it('returns id as number', async () => {
    const list = await listHistoryImpl(db, userId, 1);
    expect(typeof list[0]!.id).toBe('number');
  });
});

describe('loadHomeImpl', () => {
  it('null when sub missing', async () => {
    expect(await loadHomeImpl(await makeTestDb(), null)).toBeNull();
  });
  it('null when sub does not map', async () => {
    expect(await loadHomeImpl(await makeTestDb(), 'nope')).toBeNull();
  });
  it('returns me + current', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    await setIntentImpl(db, u.id, { text: 'shipping' });
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.me.login).toBe('alice');
    expect(home?.current.text).toBe('shipping');
  });
  it('returns empty current when no row', async () => {
    const db = await makeTestDb();
    await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    const home = await loadHomeImpl(db, 'sso-a');
    expect(home?.current.text).toBe('');
  });
});

describe('findApiClientImpl', () => {
  it('looks up a row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await db.execute(sql`
      INSERT INTO intent.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli-test', 'CLI', 'sec-xyz', ${u.id})
    `);
    const r = await findApiClientImpl(db, 'cli-test');
    expect(r?.name).toBe('CLI');
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});

describe('createApiClientSchema', () => {
  it('rejects bad client_id', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'BAD', name: 'x' }).success).toBe(false);
  });
  it('accepts kebab-cased', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'ext-1', name: 'x' }).success).toBe(true);
  });
});

describe('api-client CRUD', () => {
  async function clearSeed(db: TestDB) {
    await db.execute(sql`DELETE FROM intent.api_clients`);
  }

  it('createApiClientImpl inserts + returns plaintext secret', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createApiClientImpl(db, u.id, { clientId: 'ext-1', name: 'Ext' }, now);
    expect(r.clientId).toBe('ext-1');
    expect(r.hmacSecret.length).toBeGreaterThan(20);
    expect(r.createdAt).toBe(now.toISOString());
  });

  it('listApiClientsImpl returns DESC', async () => {
    const db = await makeTestDb();
    await clearSeed(db);
    const u = await insertPmUser(db, { login: 'a' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    await createApiClientImpl(db, u.id, { clientId: 'a', name: 'A' }, t0);
    await createApiClientImpl(db, u.id, { clientId: 'b', name: 'B' }, new Date(t0.getTime() + 60_000));
    const list = await listApiClientsImpl(db, u.id);
    expect(list.map((c) => c.clientId)).toEqual(['b', 'a']);
  });

  it('listApiClientsImpl per-user scoping', async () => {
    const db = await makeTestDb();
    await clearSeed(db);
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    await createApiClientImpl(db, a.id, { clientId: 'a-cli', name: 'A' });
    expect(await listApiClientsImpl(db, b.id)).toEqual([]);
  });

  it('deleteApiClientImpl removes', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await createApiClientImpl(db, u.id, { clientId: 'x', name: 'X' });
    expect(await deleteApiClientImpl(db, u.id, 'x')).toBe(true);
    expect(await findApiClientImpl(db, 'x')).toBeNull();
  });

  it('deleteApiClientImpl refuses foreign', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    await createApiClientImpl(db, a.id, { clientId: 'a-cli', name: 'A' });
    expect(await deleteApiClientImpl(db, b.id, 'a-cli')).toBe(false);
  });

  it('deleteApiClientImpl false for unknown', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    expect(await deleteApiClientImpl(db, u.id, 'nope')).toBe(false);
  });
});

describe('findUserBySsoImpl', () => {
  it('finds an active user', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    const found = await findUserBySsoImpl(db, 'sso-a');
    expect(found?.id).toBe(u.id);
    expect(found?.login).toBe('a');
    expect(found?.isAdmin).toBe(false);
  });
  it('null for unknown sub', async () => {
    expect(await findUserBySsoImpl(await makeTestDb(), 'nope')).toBeNull();
  });
});

describe('_testing helpers', () => {
  it('toIso handles Date', () => {
    expect(_testing.toIso(new Date('2026-05-24T10:00:00Z'))).toBe('2026-05-24T10:00:00.000Z');
  });
  it('toIso handles string', () => {
    expect(_testing.toIso('2026-05-24T10:00:00Z')).toBe('2026-05-24T10:00:00.000Z');
  });
});
