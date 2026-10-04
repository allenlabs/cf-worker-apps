import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  _testing,
  createApiClientImpl,
  createApiClientSchema,
  createEventImpl,
  deleteApiClientImpl,
  eventSchema,
  findApiClientImpl,
  getRandomWinImpl,
  listApiClientsImpl,
  listPagedImpl,
  listRecentImpl,
  loadHomeImpl,
} from '~/server/dopamine';
import { findUserBySsoImpl } from '~/server/users';

describe('eventSchema', () => {
  it('accepts a minimal pr_merged', () => {
    expect(
      eventSchema.safeParse({ kind: 'pr_merged', title: 'feat: ship' }).success,
    ).toBe(true);
  });
  it('rejects unknown kind', () => {
    expect(eventSchema.safeParse({ kind: 'unknown', title: 'x' }).success).toBe(false);
  });
  it('rejects empty title', () => {
    expect(eventSchema.safeParse({ kind: 'custom', title: '' }).success).toBe(false);
  });
  it('rejects > 280-char title', () => {
    expect(eventSchema.safeParse({ kind: 'custom', title: 'x'.repeat(281) }).success).toBe(false);
  });
  it('rejects importance out of range', () => {
    expect(eventSchema.safeParse({ kind: 'custom', title: 'x', importance: 0 }).success).toBe(false);
    expect(eventSchema.safeParse({ kind: 'custom', title: 'x', importance: 4 }).success).toBe(false);
  });
  it('rejects > 16 tags', () => {
    expect(
      eventSchema.safeParse({
        kind: 'custom',
        title: 'x',
        tags: Array.from({ length: 17 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });
  it('accepts null body / source_ref', () => {
    expect(
      eventSchema.safeParse({
        kind: 'custom', title: 'x', body: null, source_ref: null,
      }).success,
    ).toBe(true);
  });
});

describe('createEventImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts a fresh event with defaults', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createEventImpl(
      db,
      userId,
      { kind: 'pr_merged', title: 'ship feat' },
      now,
    );
    expect(r.kind).toBe('pr_merged');
    expect(r.title).toBe('ship feat');
    expect(r.importance).toBe(1);
    expect(r.tags).toEqual([]);
    expect(r.occurredAt).toBe('2026-05-24T10:00:00.000Z');
  });

  it('persists tags, importance, body, source_ref', async () => {
    const r = await createEventImpl(db, userId, {
      kind: 'custom',
      title: 'win',
      importance: 3,
      tags: ['e2e-test', 'work'],
      body: 'context here',
      source_ref: 'pr#42',
    });
    expect(r.importance).toBe(3);
    expect(r.tags).toEqual(['e2e-test', 'work']);
    expect(r.body).toBe('context here');
    expect(r.sourceRef).toBe('pr#42');
  });

  it('tag literal escapes quotes + backslashes', async () => {
    const r = await createEventImpl(db, userId, {
      kind: 'custom',
      title: 'x',
      tags: ['has"quote', 'has\\back'],
    });
    expect(r.tags).toEqual(['has"quote', 'has\\back']);
  });
});

describe('listRecentImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    userId = u.id;
    const base = new Date('2026-05-24T10:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      await createEventImpl(
        db,
        userId,
        { kind: 'pr_merged', title: `pr ${i}` },
        new Date(base + i * 60_000),
      );
    }
  });

  it('returns events DESC by occurred_at', async () => {
    const list = await listRecentImpl(db, userId);
    expect(list.length).toBe(5);
    expect(list[0]!.title).toBe('pr 4');
    expect(list[4]!.title).toBe('pr 0');
  });

  it('respects limit', async () => {
    const list = await listRecentImpl(db, userId, 2);
    expect(list.length).toBe(2);
  });

  it('clamps limit to [1, 500]', async () => {
    expect((await listRecentImpl(db, userId, 0)).length).toBe(1);
    expect((await listRecentImpl(db, userId, -5)).length).toBe(1);
    expect((await listRecentImpl(db, userId, 9999)).length).toBe(5);
  });

  it('per-user scoping', async () => {
    const other = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    expect((await listRecentImpl(db, other.id)).length).toBe(0);
  });
});

describe('listPagedImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    userId = u.id;
    const base = new Date('2026-05-24T10:00:00Z').getTime();
    for (let i = 0; i < 5; i++) {
      await createEventImpl(
        db,
        userId,
        { kind: 'custom', title: `e${i}` },
        new Date(base + i * 60_000),
      );
    }
  });

  it('paginates', async () => {
    const p0 = await listPagedImpl(db, userId, 2, 0);
    const p1 = await listPagedImpl(db, userId, 2, 2);
    expect(p0.map((e) => e.title)).toEqual(['e4', 'e3']);
    expect(p1.map((e) => e.title)).toEqual(['e2', 'e1']);
  });

  it('clamps negative offset', async () => {
    const r = await listPagedImpl(db, userId, 2, -5);
    expect(r.length).toBe(2);
  });

  it('clamps limit to [1, 500]', async () => {
    expect((await listPagedImpl(db, userId, 0)).length).toBe(1);
    expect((await listPagedImpl(db, userId, 9999)).length).toBe(5);
  });
});

describe('getRandomWinImpl', () => {
  it('returns null when empty', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    expect(await getRandomWinImpl(db, u.id)).toBeNull();
  });
  it('returns a row when present', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await createEventImpl(db, u.id, { kind: 'pr_merged', title: 'shipped' });
    const r = await getRandomWinImpl(db, u.id, 90);
    expect(r?.title).toBe('shipped');
  });
  it('excludes events older than sinceDays', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const old = new Date(now.getTime() - 100 * 86400_000);
    await createEventImpl(db, u.id, { kind: 'pr_merged', title: 'old' }, old);
    const r = await getRandomWinImpl(db, u.id, 30, now);
    expect(r).toBeNull();
  });
  it('clamps sinceDays to >= 1', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await createEventImpl(db, u.id, { kind: 'pr_merged', title: 'today' }, now);
    const r = await getRandomWinImpl(db, u.id, 0, now);
    expect(r?.title).toBe('today');
  });
});

describe('loadHomeImpl', () => {
  it('null when sub missing', async () => {
    expect(await loadHomeImpl(await makeTestDb(), null)).toBeNull();
  });
  it('null when sub does not map', async () => {
    expect(await loadHomeImpl(await makeTestDb(), 'nope')).toBeNull();
  });
  it('returns me + recent', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    await createEventImpl(db, u.id, { kind: 'pr_merged', title: 'won' });
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.me.login).toBe('alice');
    expect(home?.recent.length).toBe(1);
  });
});

describe('findApiClientImpl', () => {
  it('looks up a row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await db.execute(sql`
      INSERT INTO dopamine.api_clients (client_id, name, hmac_secret, user_id)
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
    await db.execute(sql`DELETE FROM dopamine.api_clients`);
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
    expect(found?.isAdmin).toBe(false);
  });
  it('null for unknown sub', async () => {
    expect(await findUserBySsoImpl(await makeTestDb(), 'nope')).toBeNull();
  });
});

describe('_testing helpers', () => {
  it('parsePgArrayLiteral', () => {
    const f = _testing.parsePgArrayLiteral;
    expect(f('{}')).toEqual([]);
    expect(f('foo')).toEqual([]);
    expect(f('{a,b,c}')).toEqual(['a', 'b', 'c']);
    expect(f('{"hello, world",plain}')).toEqual(['hello, world', 'plain']);
    expect(f('{"with \\"quote\\""}')).toEqual(['with "quote"']);
  });
  it('normaliseTags', () => {
    const n = _testing.normaliseTags;
    expect(n(['a', 'b'])).toEqual(['a', 'b']);
    expect(n(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(n('{e2e-test,curl}')).toEqual(['e2e-test', 'curl']);
    expect(n(null)).toEqual([]);
    expect(n(42)).toEqual([]);
  });
  it('tagsToLiteral', () => {
    expect(_testing.tagsToLiteral([])).toBe('{}');
    expect(_testing.tagsToLiteral(['a', 'b'])).toBe('{"a","b"}');
    expect(_testing.tagsToLiteral(['a"b'])).toBe('{"a\\"b"}');
  });
  it('toIso', () => {
    expect(_testing.toIso(new Date('2026-05-24T10:00:00Z'))).toBe('2026-05-24T10:00:00.000Z');
    expect(_testing.toIso('2026-05-24T10:00:00Z')).toBe('2026-05-24T10:00:00.000Z');
  });
  it('rowToEvent defaults', () => {
    const r = _testing.rowToEvent({ id: 1, kind: 'custom', title: 't', tags: null, occurredAt: '2026-05-24T10:00:00Z' });
    expect(r.body).toBeNull();
    expect(r.sourceRef).toBeNull();
    expect(r.importance).toBe(1);
    expect(r.tags).toEqual([]);
  });
});
