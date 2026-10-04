import { describe, it, expect, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
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
  rangeHeatmapImpl,
  rangeQuerySchema,
  upsertCheckinImpl,
} from '~/server/gentle';
import { findUserBySsoImpl } from '~/server/users';

describe('checkinSchema', () => {
  it('accepts an empty payload (all toggles null is valid)', () => {
    expect(checkinSchema.safeParse({}).success).toBe(true);
  });
  it('accepts every toggle plus note + date', () => {
    expect(
      checkinSchema.safeParse({
        slept_ok: true,
        meds: false,
        ate: true,
        moved: true,
        talked: null,
        note: 'meh',
        date: '2026-05-24',
      }).success,
    ).toBe(true);
  });
  it('rejects bad date format', () => {
    expect(checkinSchema.safeParse({ date: '5/24/26' }).success).toBe(false);
  });
  it('rejects non-boolean toggles', () => {
    expect(checkinSchema.safeParse({ slept_ok: 'yes' }).success).toBe(false);
  });
  it('rejects an oversized note', () => {
    expect(checkinSchema.safeParse({ note: 'x'.repeat(1001) }).success).toBe(false);
  });
});

describe('rangeQuerySchema', () => {
  it('accepts a valid pair', () => {
    expect(rangeQuerySchema.safeParse({ from: '2026-05-01', to: '2026-05-24' }).success).toBe(true);
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

  it('inserts a fresh entry with explicit toggles', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await upsertCheckinImpl(
      db,
      userId,
      { slept_ok: true, meds: true, ate: false, moved: true, talked: true, note: 'fine' },
      now,
    );
    expect(r.entryDate).toBe('2026-05-24');
    expect(r.sleptOk).toBe(true);
    expect(r.meds).toBe(true);
    expect(r.ate).toBe(false);
    expect(r.moved).toBe(true);
    expect(r.talked).toBe(true);
    expect(r.note).toBe('fine');
  });

  it('inserts a row with everything null (just "I showed up" mode)', async () => {
    const r = await upsertCheckinImpl(db, userId, {}, new Date('2026-05-24T10:00:00Z'));
    expect(r.sleptOk).toBeNull();
    expect(r.meds).toBeNull();
    expect(r.ate).toBeNull();
    expect(r.moved).toBeNull();
    expect(r.talked).toBeNull();
    expect(r.note).toBeNull();
  });

  it('upserts on the same day', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, userId, { slept_ok: false }, now);
    const updated = await upsertCheckinImpl(
      db,
      userId,
      { slept_ok: true, note: 'better in the afternoon' },
      new Date('2026-05-24T22:00:00Z'),
    );
    expect(updated.sleptOk).toBe(true);
    expect(updated.note).toBe('better in the afternoon');
    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS c FROM gentle.checkins WHERE user_id = ${userId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { c: number }).c).toBe(1);
  });

  it('explicit date overrides default', async () => {
    const r = await upsertCheckinImpl(db, userId, { slept_ok: true, date: '2026-05-22' });
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
    await upsertCheckinImpl(db, u.id, { slept_ok: true, meds: true }, now);
    const got = await getTodayImpl(db, u.id, now);
    expect(got?.sleptOk).toBe(true);
    expect(got?.meds).toBe(true);
    expect(got?.entryDate).toBe('2026-05-24');
  });
  it('per-user scoping', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, a.id, { slept_ok: true }, now);
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
      await upsertCheckinImpl(db, userId, { slept_ok: true, date: d });
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

describe('rangeHeatmapImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    userId = u.id;
  });

  it('emits a cell for every day in the range with null for missed days', async () => {
    await upsertCheckinImpl(db, userId, {
      slept_ok: true, meds: true, ate: true, moved: true, talked: true,
      date: '2026-05-22',
    });
    const cells = await rangeHeatmapImpl(db, userId, '2026-05-20', '2026-05-24');
    expect(cells.length).toBe(5);
    expect(cells.map((c) => c.date)).toEqual([
      '2026-05-20', '2026-05-21', '2026-05-22', '2026-05-23', '2026-05-24',
    ]);
    expect(cells.find((c) => c.date === '2026-05-22')!.score).toBe(5);
    expect(cells.find((c) => c.date === '2026-05-20')!.score).toBeNull();
  });

  it('counts only TRUE toggles (false + null = 0)', async () => {
    await upsertCheckinImpl(db, userId, {
      slept_ok: true, meds: false, ate: null, moved: true, talked: null,
      date: '2026-05-23',
    });
    const cells = await rangeHeatmapImpl(db, userId, '2026-05-23', '2026-05-23');
    expect(cells[0]!.score).toBe(2);
  });

  it('returns [] for malformed range', async () => {
    expect(await rangeHeatmapImpl(db, userId, 'bad', '2026-05-24')).toEqual([]);
    expect(await rangeHeatmapImpl(db, userId, '2026-05-24', '2026-05-20')).toEqual([]);
  });
});

describe('null-column hydration', () => {
  it('hydrates a row with all-null toggles + note', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await db.execute(sql`
      INSERT INTO gentle.checkins (user_id, entry_date, slept_ok, meds, ate, moved, talked, note)
      VALUES (${u.id}, '2026-05-22'::date, NULL, NULL, NULL, NULL, NULL, NULL)
    `);
    const got = await getByDateImpl(db, u.id, '2026-05-22');
    expect(got?.sleptOk).toBeNull();
    expect(got?.meds).toBeNull();
    expect(got?.ate).toBeNull();
    expect(got?.moved).toBeNull();
    expect(got?.talked).toBeNull();
    expect(got?.note).toBeNull();
  });
});

describe('loadHomeImpl', () => {
  it('null when no sub', async () => {
    expect(await loadHomeImpl(await makeTestDb(), null)).toBeNull();
  });
  it('null when sub does not map', async () => {
    expect(await loadHomeImpl(await makeTestDb(), 'nope')).toBeNull();
  });
  it('returns me + today + recent (last 14 days)', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await upsertCheckinImpl(db, u.id, { slept_ok: true, date: '2026-05-24' }, now);
    await upsertCheckinImpl(db, u.id, { slept_ok: false, date: '2026-05-20' }, now);
    const home = await loadHomeImpl(db, 'sso-a', now);
    expect(home?.me.login).toBe('a');
    expect(home?.today?.sleptOk).toBe(true);
    expect(home?.recent.length).toBe(2);
  });
});

describe('findApiClientImpl', () => {
  it('finds a row + null for missing', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await db.execute(sql`
      INSERT INTO gentle.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli-test', 'CLI', 'sec-xyz', ${u.id})
    `);
    const r = await findApiClientImpl(db, 'cli-test');
    expect(r?.name).toBe('CLI');
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});

describe('createApiClientSchema', () => {
  it('rejects uppercase client_id', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'BAD', name: 'x' }).success).toBe(false);
  });
  it('accepts kebab-case', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'ext-1', name: 'x' }).success).toBe(true);
  });
});

describe('api-client CRUD', () => {
  async function clearSeed(db: TestDB) {
    await db.execute(sql`DELETE FROM gentle.api_clients`);
  }

  it('createApiClientImpl + listApiClientsImpl + deleteApiClientImpl', async () => {
    const db = await makeTestDb();
    await clearSeed(db);
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    await createApiClientImpl(db, a.id, { clientId: 'x', name: 'X' }, t0);
    await createApiClientImpl(db, a.id, { clientId: 'y', name: 'Y' }, new Date(t0.getTime() + 60_000));
    const list = await listApiClientsImpl(db, a.id);
    expect(list.map((c) => c.clientId)).toEqual(['y', 'x']);
    expect(await listApiClientsImpl(db, b.id)).toEqual([]);
    expect(await deleteApiClientImpl(db, b.id, 'x')).toBe(false);
    expect(await deleteApiClientImpl(db, a.id, 'x')).toBe(true);
    expect(await deleteApiClientImpl(db, a.id, 'nope')).toBe(false);
  });

  it('returned secret is plaintext base64 with non-trivial entropy', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const r = await createApiClientImpl(db, u.id, { clientId: 'ext-1', name: 'Ext' });
    expect(r.hmacSecret.length).toBeGreaterThan(20);
  });
});

describe('findUserBySsoImpl', () => {
  it('finds an active user', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    const found = await findUserBySsoImpl(db, 'sso-a');
    expect(found?.id).toBe(u.id);
  });
  it('null for unknown sub', async () => {
    expect(await findUserBySsoImpl(await makeTestDb(), 'nope')).toBeNull();
  });
});

describe('_testing helpers', () => {
  it('nullableBool handles strings + booleans + null', () => {
    const n = _testing.nullableBool;
    expect(n(true)).toBe(true);
    expect(n(false)).toBe(false);
    expect(n('t')).toBe(true);
    expect(n('f')).toBe(false);
    expect(n('true')).toBe(true);
    expect(n('false')).toBe(false);
    expect(n(null)).toBeNull();
    expect(n(undefined)).toBeNull();
    // Unrecognized string falls through both inner conditions.
    expect(n('maybe')).toBeNull();
  });

  it('countTrues exhaustively (every toggle slot contributes)', () => {
    const base = {
      id: 1,
      userId: 1,
      entryDate: '2026-05-24',
      sleptOk: null,
      meds: null,
      ate: null,
      moved: null,
      talked: null,
      note: null,
      createdAt: '2026-05-24T00:00:00Z',
      updatedAt: '2026-05-24T00:00:00Z',
    };
    expect(_testing.countTrues(base)).toBe(0);
    expect(_testing.countTrues({ ...base, sleptOk: true })).toBe(1);
    expect(_testing.countTrues({ ...base, meds: true })).toBe(1);
    expect(_testing.countTrues({ ...base, ate: true })).toBe(1);
    expect(_testing.countTrues({ ...base, moved: true })).toBe(1);
    expect(_testing.countTrues({ ...base, talked: true })).toBe(1);
    // false / null do NOT count.
    expect(_testing.countTrues({ ...base, sleptOk: false, meds: false, ate: false })).toBe(0);
    expect(_testing.countTrues({
      ...base, sleptOk: true, meds: true, ate: true, moved: true, talked: true,
    })).toBe(5);
  });
});
