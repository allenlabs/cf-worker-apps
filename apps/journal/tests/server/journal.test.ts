import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  _testing,
  checkinSchema,
  createApiClientImpl,
  createApiClientSchema,
  deleteApiClientImpl,
  findApiClientImpl,
  getByDateImpl,
  getTodayImpl,
  listApiClientsImpl,
  listRangeImpl,
  loadHomeImpl,
  rangeQuerySchema,
  statsImpl,
  upsertCheckinImpl,
} from '~/server/journal';
import { findUserBySsoImpl } from '~/server/users';

describe('checkinSchema', () => {
  it('accepts a minimal payload', () => {
    expect(
      checkinSchema.safeParse({ mood: 3, energy: 3, focus: 3 }).success,
    ).toBe(true);
  });
  it('rejects out-of-range scores', () => {
    expect(checkinSchema.safeParse({ mood: 0, energy: 3, focus: 3 }).success).toBe(false);
    expect(checkinSchema.safeParse({ mood: 6, energy: 3, focus: 3 }).success).toBe(false);
  });
  it('rejects non-int scores', () => {
    expect(checkinSchema.safeParse({ mood: 3.5, energy: 3, focus: 3 }).success).toBe(false);
  });
  it('rejects bad date format', () => {
    expect(checkinSchema.safeParse({ mood: 3, energy: 3, focus: 3, date: '5/24/26' }).success).toBe(false);
  });
  it('accepts iso date', () => {
    expect(
      checkinSchema.safeParse({ mood: 3, energy: 3, focus: 3, date: '2026-05-24' }).success,
    ).toBe(true);
  });
  it('rejects mind / blockers > 10KB', () => {
    expect(
      checkinSchema.safeParse({
        mood: 3, energy: 3, focus: 3,
        mind: 'x'.repeat(10_001),
      }).success,
    ).toBe(false);
  });
  it('rejects too many tags', () => {
    expect(
      checkinSchema.safeParse({
        mood: 3, energy: 3, focus: 3,
        tags: Array.from({ length: 17 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });
  it('accepts null mind/blockers', () => {
    expect(
      checkinSchema.safeParse({ mood: 3, energy: 3, focus: 3, mind: null, blockers: null }).success,
    ).toBe(true);
  });
});

describe('rangeQuerySchema', () => {
  it('accepts yyyy-mm-dd pair', () => {
    expect(
      rangeQuerySchema.safeParse({ from: '2026-05-01', to: '2026-05-24' }).success,
    ).toBe(true);
  });
  it('rejects malformed dates', () => {
    expect(rangeQuerySchema.safeParse({ from: 'x', to: '2026-05-24' }).success).toBe(false);
  });
});

describe('upsertCheckinImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts a fresh entry', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await upsertCheckinImpl(
      db,
      userId,
      { mood: 4, energy: 3, focus: 5, mind: 'felt ok', blockers: 'meetings' },
      now,
    );
    expect(r.mood).toBe(4);
    expect(r.entryDate).toBe('2026-05-24');
    expect(r.mind).toBe('felt ok');
  });

  it('upserts on the same day', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, userId, { mood: 1, energy: 1, focus: 1 }, now);
    const updated = await upsertCheckinImpl(
      db,
      userId,
      { mood: 5, energy: 5, focus: 5, mind: 'better' },
      new Date('2026-05-24T22:00:00Z'),
    );
    expect(updated.mood).toBe(5);
    expect(updated.mind).toBe('better');
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM journal.entries WHERE user_id = ${userId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { c: number }).c).toBe(1);
  });

  it('persists tags + source', async () => {
    const r = await upsertCheckinImpl(
      db,
      userId,
      { mood: 3, energy: 3, focus: 3, tags: ['e2e-test', 'work'], source: 'cli' },
    );
    expect(r.tags).toEqual(['e2e-test', 'work']);
    expect(r.source).toBe('cli');
  });

  it('preserves existing source when upsert source is undefined', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, userId, { mood: 3, energy: 3, focus: 3, source: 'cli' }, now);
    const r = await upsertCheckinImpl(
      db,
      userId,
      { mood: 4, energy: 3, focus: 3 },
      new Date('2026-05-24T22:00:00Z'),
    );
    expect(r.source).toBe('cli');
  });

  it('explicit date overrides default', async () => {
    const r = await upsertCheckinImpl(db, userId, {
      mood: 3, energy: 3, focus: 3, date: '2026-05-22',
    });
    expect(r.entryDate).toBe('2026-05-22');
  });
});

describe('getTodayImpl + getByDateImpl', () => {
  it('returns null when missing', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    expect(await getTodayImpl(db, u.id)).toBeNull();
    expect(await getByDateImpl(db, u.id, '2026-05-24')).toBeNull();
  });
  it('returns the row when present', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, u.id, { mood: 5, energy: 5, focus: 5 }, now);
    const got = await getTodayImpl(db, u.id, now);
    expect(got?.mood).toBe(5);
    expect(got?.entryDate).toBe('2026-05-24');
  });
  it('per-user scoping', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, a.id, { mood: 3, energy: 3, focus: 3 }, now);
    expect(await getTodayImpl(db, b.id, now)).toBeNull();
  });
});

describe('listRangeImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    userId = u.id;
    for (const d of ['2026-05-20', '2026-05-22', '2026-05-24']) {
      await upsertCheckinImpl(db, userId, { mood: 3, energy: 3, focus: 3, date: d });
    }
  });

  it('returns entries DESC by date', async () => {
    const list = await listRangeImpl(db, userId, '2026-05-19', '2026-05-25');
    expect(list.map((e) => e.entryDate)).toEqual(['2026-05-24', '2026-05-22', '2026-05-20']);
  });

  it('respects from/to bounds', async () => {
    const list = await listRangeImpl(db, userId, '2026-05-21', '2026-05-23');
    expect(list.map((e) => e.entryDate)).toEqual(['2026-05-22']);
  });

  it('[] when to < from', async () => {
    expect(await listRangeImpl(db, userId, '2026-05-24', '2026-05-20')).toEqual([]);
  });

  it('[] when dates malformed', async () => {
    expect(await listRangeImpl(db, userId, 'bad', '2026-05-24')).toEqual([]);
    expect(await listRangeImpl(db, userId, '2026-05-24', 'also-bad')).toEqual([]);
  });

  it('per-user scoping', async () => {
    const other = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    expect(await listRangeImpl(db, other.id, '2026-05-19', '2026-05-25')).toEqual([]);
  });
});

describe('null-column hydration', () => {
  it('hydrates a row that has NULL mood/energy/focus/mind/blockers/source', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await db.execute(sql`
      INSERT INTO journal.entries (user_id, entry_date, mood, energy, focus, mind, blockers, source)
      VALUES (${u.id}, '2026-05-22'::date, NULL, NULL, NULL, NULL, NULL, NULL)
    `);
    const got = await getByDateImpl(db, u.id, '2026-05-22');
    expect(got?.mood).toBeNull();
    expect(got?.energy).toBeNull();
    expect(got?.focus).toBeNull();
    expect(got?.mind).toBeNull();
    expect(got?.blockers).toBeNull();
    expect(got?.source).toBeNull();
  });
});

describe('statsImpl', () => {
  it('returns 90-day heatmap + null averages when empty', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const stats = await statsImpl(db, u.id, new Date('2026-05-24T10:00:00Z'));
    expect(stats.total).toBe(0);
    expect(stats.averages.mood).toBeNull();
    expect(stats.heatmap.length).toBe(90);
    expect(stats.heatmap.every((c) => c.score === null)).toBe(true);
  });

  it('computes averages when entries exist', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, u.id, { mood: 4, energy: 4, focus: 4, date: '2026-05-22' }, now);
    await upsertCheckinImpl(db, u.id, { mood: 2, energy: 2, focus: 2, date: '2026-05-24' }, now);
    const stats = await statsImpl(db, u.id, now);
    expect(stats.total).toBe(2);
    expect(stats.averages.mood).toBe(3);
    expect(stats.averages.energy).toBe(3);
    expect(stats.averages.focus).toBe(3);
    expect(stats.heatmap.find((c) => c.date === '2026-05-22')?.score).toBe(12);
    expect(stats.heatmap.find((c) => c.date === '2026-05-24')?.score).toBe(6);
  });

  it('heatmap last entry is today', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const stats = await statsImpl(db, u.id, now);
    expect(stats.heatmap.at(-1)?.date).toBe('2026-05-24');
  });

  it('handles NULL-column rows in the heatmap (treats them as 0-summed)', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await db.execute(sql`
      INSERT INTO journal.entries (user_id, entry_date, mood, energy, focus)
      VALUES (${u.id}, '2026-05-23'::date, NULL, NULL, NULL)
    `);
    const stats = await statsImpl(db, u.id, now);
    const cell = stats.heatmap.find((c) => c.date === '2026-05-23');
    expect(cell?.score).toBe(0);
    // Averages skip rows where any score is null.
    expect(stats.averages.mood).toBeNull();
  });
});

describe('loadHomeImpl', () => {
  it('null when no sub', async () => {
    expect(await loadHomeImpl(await makeTestDb(), null)).toBeNull();
  });
  it('null when sub does not map', async () => {
    expect(await loadHomeImpl(await makeTestDb(), 'nope')).toBeNull();
  });
  it('returns me + today + recent', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, u.id, { mood: 4, energy: 4, focus: 4 }, now);
    await upsertCheckinImpl(db, u.id, { mood: 3, energy: 3, focus: 3, date: '2026-05-20' }, now);
    const home = await loadHomeImpl(db, 'sso-a', now);
    expect(home?.me.login).toBe('a');
    expect(home?.today?.mood).toBe(4);
    expect(home?.recent.length).toBe(2);
  });
});

describe('findApiClientImpl', () => {
  it('looks up a row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await db.execute(sql`
      INSERT INTO journal.api_clients (client_id, name, hmac_secret, user_id)
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
    await db.execute(sql`DELETE FROM journal.api_clients`);
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
  it('round1', () => {
    expect(_testing.round1(3.4567)).toBe(3.5);
    expect(_testing.round1(3.04)).toBe(3);
  });
});
