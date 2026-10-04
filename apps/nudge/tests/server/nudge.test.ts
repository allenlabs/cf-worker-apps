import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  _testing,
  computeNextFire,
  createApiClientImpl,
  createApiClientSchema,
  createReminderImpl,
  createSchema,
  deleteApiClientImpl,
  deleteReminderImpl,
  dismissReminderImpl,
  findApiClientImpl,
  getReminderImpl,
  listAllImpl,
  listApiClientsImpl,
  listDueImpl,
  listUpcomingImpl,
  loadHomeImpl,
  markDeliveredImpl,
  snoozeReminderImpl,
} from '~/server/nudge';
import { findUserBySsoImpl } from '~/server/users';

describe('createSchema', () => {
  it('rejects empty text', () => {
    expect(createSchema.safeParse({ text: '', relativeSeconds: 30 }).success).toBe(false);
  });
  it('rejects whitespace-only text', () => {
    expect(createSchema.safeParse({ text: '   ', relativeSeconds: 30 }).success).toBe(false);
  });
  it('requires fireAt or relativeSeconds', () => {
    expect(createSchema.safeParse({ text: 'x' }).success).toBe(false);
  });
  it('accepts fireAt only', () => {
    expect(
      createSchema.safeParse({ text: 'x', fireAt: '2026-05-24T10:00:00.000Z' }).success,
    ).toBe(true);
  });
  it('accepts relativeSeconds only', () => {
    expect(createSchema.safeParse({ text: 'x', relativeSeconds: 60 }).success).toBe(true);
  });
  it('rejects negative relativeSeconds', () => {
    expect(createSchema.safeParse({ text: 'x', relativeSeconds: -1 }).success).toBe(false);
  });
  it('accepts daily / weekly / monthly recurrence', () => {
    for (const r of ['daily', 'weekly', 'monthly']) {
      expect(
        createSchema.safeParse({ text: 'x', relativeSeconds: 60, recurrence: r }).success,
      ).toBe(true);
    }
  });
  it('accepts every:Nx recurrence', () => {
    for (const r of ['every:30s', 'every:5m', 'every:2h', 'every:7d']) {
      expect(
        createSchema.safeParse({ text: 'x', relativeSeconds: 60, recurrence: r }).success,
      ).toBe(true);
    }
  });
  it('rejects invalid recurrence', () => {
    expect(
      createSchema.safeParse({ text: 'x', relativeSeconds: 60, recurrence: 'bogus' }).success,
    ).toBe(false);
  });
  it('rejects > 16 tags', () => {
    expect(
      createSchema.safeParse({
        text: 'x',
        relativeSeconds: 60,
        tags: Array.from({ length: 17 }, (_, i) => `t${i}`),
      }).success,
    ).toBe(false);
  });
});

describe('computeNextFire', () => {
  const from = new Date('2026-05-24T10:00:00Z');
  it('returns null for falsy recurrence', () => {
    expect(computeNextFire(null, from)).toBeNull();
    expect(computeNextFire(undefined, from)).toBeNull();
    expect(computeNextFire('', from)).toBeNull();
  });
  it('advances daily by 24h', () => {
    expect(computeNextFire('daily', from)!.toISOString()).toBe('2026-05-25T10:00:00.000Z');
  });
  it('advances weekly by 7d', () => {
    expect(computeNextFire('weekly', from)!.toISOString()).toBe('2026-05-31T10:00:00.000Z');
  });
  it('advances monthly via UTC month', () => {
    expect(computeNextFire('monthly', from)!.toISOString()).toBe('2026-06-24T10:00:00.000Z');
  });
  it('advances every:30s', () => {
    expect(computeNextFire('every:30s', from)!.toISOString()).toBe('2026-05-24T10:00:30.000Z');
  });
  it('advances every:5m', () => {
    expect(computeNextFire('every:5m', from)!.toISOString()).toBe('2026-05-24T10:05:00.000Z');
  });
  it('advances every:2h', () => {
    expect(computeNextFire('every:2h', from)!.toISOString()).toBe('2026-05-24T12:00:00.000Z');
  });
  it('advances every:1d', () => {
    expect(computeNextFire('every:1d', from)!.toISOString()).toBe('2026-05-25T10:00:00.000Z');
  });
  it('returns null for every:0x (ms<=0)', () => {
    expect(computeNextFire('every:0m', from)).toBeNull();
  });
});

describe('createReminderImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts a one-shot reminder with fireAt', async () => {
    const fireAt = new Date('2026-05-24T11:00:00Z');
    const r = await createReminderImpl(
      db,
      userId,
      { text: 'water', fireAt: fireAt.toISOString() },
      new Date('2026-05-24T10:00:00Z'),
    );
    expect(typeof r.id).toBe('number');
    expect(r.fireAt).toBe(fireAt.toISOString());
    expect(r.nextFireAt).toBeNull();
  });

  it('inserts with relativeSeconds', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createReminderImpl(
      db,
      userId,
      { text: 'water', relativeSeconds: 600 },
      now,
    );
    expect(r.fireAt).toBe('2026-05-24T10:10:00.000Z');
  });

  it('sets nextFireAt for recurring reminders', async () => {
    const fireAt = new Date('2026-05-24T10:00:00Z');
    const r = await createReminderImpl(
      db,
      userId,
      { text: 'stand up', fireAt: fireAt.toISOString(), recurrence: 'daily' },
      fireAt,
    );
    expect(r.nextFireAt).toBe('2026-05-25T10:00:00.000Z');
  });

  it('persists tags and source', async () => {
    const r = await createReminderImpl(db, userId, {
      text: 't',
      relativeSeconds: 1,
      tags: ['e2e-test', 'curl'],
      source: 'cli',
    });
    const row = await getReminderImpl(db, userId, r.id);
    expect(row?.tags).toEqual(['e2e-test', 'curl']);
    expect(row?.source).toBe('cli');
  });

  it('null recurrence is null in the row', async () => {
    const r = await createReminderImpl(db, userId, {
      text: 'one shot',
      relativeSeconds: 60,
      recurrence: null,
    });
    const row = await getReminderImpl(db, userId, r.id);
    expect(row?.recurrence).toBeNull();
    expect(row?.nextFireAt).toBeNull();
  });
});

describe('listUpcomingImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('returns [] when no reminders', async () => {
    expect(await listUpcomingImpl(db, userId)).toEqual([]);
  });

  it('returns reminders in fireAt ASC order', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    await createReminderImpl(db, userId, { text: 'b', relativeSeconds: 7200 }, now);
    await createReminderImpl(db, userId, { text: 'a', relativeSeconds: 60 }, now);
    const list = await listUpcomingImpl(db, userId, 60 * 60 * 24, now);
    expect(list.map((r) => r.text)).toEqual(['a', 'b']);
  });

  it('respects withinSeconds horizon', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    await createReminderImpl(db, userId, { text: 'near', relativeSeconds: 60 }, now);
    await createReminderImpl(db, userId, { text: 'far', relativeSeconds: 60 * 60 * 48 }, now);
    const list = await listUpcomingImpl(db, userId, 60 * 60, now);
    expect(list.map((r) => r.text)).toEqual(['near']);
  });

  it('excludes dismissed reminders', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createReminderImpl(db, userId, { text: 'x', relativeSeconds: 60 }, now);
    await dismissReminderImpl(db, userId, r.id, now);
    expect(await listUpcomingImpl(db, userId, 60 * 60 * 24, now)).toEqual([]);
  });

  it('does not leak other users', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
    await createReminderImpl(db, other.id, { text: 'theirs', relativeSeconds: 60 });
    expect(await listUpcomingImpl(db, userId)).toEqual([]);
  });
});

describe('listAllImpl', () => {
  it('returns all non-dismissed by default', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r1 = await createReminderImpl(db, u.id, { text: 'a', relativeSeconds: 60 }, now);
    await createReminderImpl(db, u.id, { text: 'b', relativeSeconds: 60 }, now);
    await dismissReminderImpl(db, u.id, r1.id, now);
    const list = await listAllImpl(db, u.id);
    expect(list.map((r) => r.text)).toEqual(['b']);
  });

  it('includes dismissed when asked', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r1 = await createReminderImpl(db, u.id, { text: 'a', relativeSeconds: 60 }, now);
    await dismissReminderImpl(db, u.id, r1.id, now);
    const list = await listAllImpl(db, u.id, { includeDismissed: true });
    expect(list.length).toBe(1);
  });

  it('caps + clamps limit', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 60 });
    expect((await listAllImpl(db, u.id, { limit: 0 })).length).toBe(1);
    expect((await listAllImpl(db, u.id, { limit: 9999 })).length).toBe(1);
  });
});

describe('getReminderImpl', () => {
  it('returns the row for the owner', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const r = await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 60 });
    const got = await getReminderImpl(db, u.id, r.id);
    expect(got?.text).toBe('x');
  });

  it('returns null for a foreign id', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const r = await createReminderImpl(db, a.id, { text: 'mine', relativeSeconds: 60 });
    expect(await getReminderImpl(db, b.id, r.id)).toBeNull();
  });

  it('returns null for a non-existent id', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    expect(await getReminderImpl(db, u.id, 99999)).toBeNull();
  });
});

describe('dismissReminderImpl', () => {
  it('marks dismissed and clears nextFireAt', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createReminderImpl(
      db,
      u.id,
      { text: 'x', relativeSeconds: 60, recurrence: 'daily' },
      now,
    );
    expect(await dismissReminderImpl(db, u.id, r.id, now)).toBe(true);
    const row = await getReminderImpl(db, u.id, r.id);
    expect(row?.dismissedAt).not.toBeNull();
    expect(row?.nextFireAt).toBeNull();
  });

  it('returns false for unknown / foreign id', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    expect(await dismissReminderImpl(db, u.id, 99999)).toBe(false);
  });

  it('refuses to dismiss already-dismissed', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const r = await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 60 });
    expect(await dismissReminderImpl(db, u.id, r.id)).toBe(true);
    expect(await dismissReminderImpl(db, u.id, r.id)).toBe(false);
  });
});

describe('snoozeReminderImpl', () => {
  it('moves fireAt forward by the snooze window', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 60 }, now);
    const updated = await snoozeReminderImpl(db, u.id, r.id, 30, now);
    expect(updated?.fireAt).toBe('2026-05-24T10:30:00.000Z');
    expect(updated?.snoozedUntil).toBe('2026-05-24T10:30:00.000Z');
  });

  it('returns null for foreign / dismissed reminders', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const r = await createReminderImpl(db, a.id, { text: 'mine', relativeSeconds: 60 });
    expect(await snoozeReminderImpl(db, b.id, r.id, 30)).toBeNull();

    const myReminder = await createReminderImpl(db, a.id, { text: 'mine2', relativeSeconds: 60 });
    await dismissReminderImpl(db, a.id, myReminder.id);
    expect(await snoozeReminderImpl(db, a.id, myReminder.id, 30)).toBeNull();
  });
});

describe('deleteReminderImpl', () => {
  it('removes the row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const r = await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 60 });
    expect(await deleteReminderImpl(db, u.id, r.id)).toBe(true);
    expect(await getReminderImpl(db, u.id, r.id)).toBeNull();
  });

  it('refuses to delete a foreign row', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const r = await createReminderImpl(db, a.id, { text: 'x', relativeSeconds: 60 });
    expect(await deleteReminderImpl(db, b.id, r.id)).toBe(false);
  });

  it('false for unknown id', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    expect(await deleteReminderImpl(db, u.id, 99999)).toBe(false);
  });
});

describe('listDueImpl', () => {
  it('returns rows with fireAt <= now', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await createReminderImpl(db, u.id, { text: 'past', relativeSeconds: 1 }, new Date(now.getTime() - 60_000));
    await createReminderImpl(db, u.id, { text: 'future', relativeSeconds: 60 }, now);
    const due = await listDueImpl(db, now);
    expect(due.map((r) => r.text)).toEqual(['past']);
  });

  it('excludes dismissed + delivered', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    const r1 = await createReminderImpl(db, u.id, { text: 'a', relativeSeconds: 1 }, past);
    await dismissReminderImpl(db, u.id, r1.id);
    const r2 = await createReminderImpl(db, u.id, { text: 'b', relativeSeconds: 1 }, past);
    await markDeliveredImpl(db, r2.id, now);
    expect(await listDueImpl(db, now)).toEqual([]);
  });

  it('caps + clamps limit', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const past = new Date(Date.now() - 60_000);
    await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 1 }, past);
    expect((await listDueImpl(db, new Date(), 0)).length).toBe(1);
    expect((await listDueImpl(db, new Date(), 9999)).length).toBe(1);
  });
});

describe('markDeliveredImpl', () => {
  it('marks one-shot reminders delivered', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 1 }, new Date(now.getTime() - 60_000));
    await markDeliveredImpl(db, r.id, now);
    const row = await getReminderImpl(db, u.id, r.id);
    expect(row?.deliveredAt).not.toBeNull();
  });

  it('advances fireAt for recurring reminders + clears deliveredAt', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const fireAt = new Date('2026-05-24T10:00:00Z');
    const r = await createReminderImpl(
      db,
      u.id,
      { text: 'water', fireAt: fireAt.toISOString(), recurrence: 'daily' },
      fireAt,
    );
    await markDeliveredImpl(db, r.id, new Date('2026-05-24T10:01:00Z'));
    const row = await getReminderImpl(db, u.id, r.id);
    expect(row?.fireAt).toBe('2026-05-25T10:00:00.000Z');
    expect(row?.deliveredAt).toBeNull();
    expect(row?.nextFireAt).toBe('2026-05-26T10:00:00.000Z');
  });
});

describe('loadHomeImpl', () => {
  it('returns null without a sub', async () => {
    const db = await makeTestDb();
    expect(await loadHomeImpl(db, null)).toBeNull();
  });
  it('returns null when sub does not map', async () => {
    const db = await makeTestDb();
    expect(await loadHomeImpl(db, 'nope')).toBeNull();
  });
  it('returns me + upcoming', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a', sub: 'sso-a' });
    const now = new Date('2026-05-24T10:00:00Z');
    await createReminderImpl(db, u.id, { text: 'soon', relativeSeconds: 60 }, now);
    const home = await loadHomeImpl(db, 'sso-a', now);
    expect(home?.me.login).toBe('a');
    expect(home?.upcoming.length).toBe(1);
    expect(home?.count).toBe(1);
  });
});

describe('findApiClientImpl', () => {
  it('looks up a row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    await db.execute(sql`
      INSERT INTO nudge.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli-test', 'CLI', 'sec-xyz', ${u.id})
    `);
    const r = await findApiClientImpl(db, 'cli-test');
    expect(r?.name).toBe('CLI');
    expect(r?.userId).toBe(u.id);
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});

describe('createApiClientSchema', () => {
  it('rejects bad client_id', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'BAD', name: 'x' }).success).toBe(false);
    expect(createApiClientSchema.safeParse({ clientId: 'a!', name: 'x' }).success).toBe(false);
  });
  it('accepts kebab-cased client_id', () => {
    expect(createApiClientSchema.safeParse({ clientId: 'ext-1', name: 'x' }).success).toBe(true);
  });
});

describe('api-client CRUD', () => {
  async function clearSeed(db: TestDB) {
    await db.execute(sql`DELETE FROM nudge.api_clients`);
  }

  it('createApiClientImpl inserts + returns plaintext secret', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await createApiClientImpl(db, u.id, { clientId: 'ext-1', name: 'Ext' }, now);
    expect(r.clientId).toBe('ext-1');
    expect(r.hmacSecret.length).toBeGreaterThan(20);
    expect(r.createdAt).toBe(now.toISOString());
    const found = await findApiClientImpl(db, 'ext-1');
    expect(found?.hmacSecret).toBe(r.hmacSecret);
  });

  it('listApiClientsImpl returns DESC created_at', async () => {
    const db = await makeTestDb();
    await clearSeed(db);
    const u = await insertPmUser(db, { login: 'a' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    await createApiClientImpl(db, u.id, { clientId: 'a', name: 'A' }, t0);
    await createApiClientImpl(db, u.id, { clientId: 'b', name: 'B' }, new Date(t0.getTime() + 60_000));
    const list = await listApiClientsImpl(db, u.id);
    expect(list.map((c) => c.clientId)).toEqual(['b', 'a']);
  });

  it('listApiClientsImpl does not leak other users', async () => {
    const db = await makeTestDb();
    await clearSeed(db);
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    await createApiClientImpl(db, a.id, { clientId: 'a-cli', name: 'A' });
    expect(await listApiClientsImpl(db, b.id)).toEqual([]);
  });

  it('deleteApiClientImpl removes the row', async () => {
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
    const db = await makeTestDb();
    expect(await findUserBySsoImpl(db, 'nope')).toBeNull();
  });
});

describe('_testing helpers', () => {
  it('parsePgArrayLiteral parses common shapes', () => {
    const f = _testing.parsePgArrayLiteral;
    expect(f('{}')).toEqual([]);
    expect(f('foo')).toEqual([]);
    expect(f('{a,b,c}')).toEqual(['a', 'b', 'c']);
    expect(f('{"hello, world",plain}')).toEqual(['hello, world', 'plain']);
    expect(f('{"with \\"quote\\""}')).toEqual(['with "quote"']);
  });
  it('normaliseTags handles arrays, strings, and other', () => {
    const n = _testing.normaliseTags;
    expect(n(['a', 'b'])).toEqual(['a', 'b']);
    expect(n(['a', 1, null, 'b'])).toEqual(['a', 'b']);
    expect(n('{e2e-test,curl}')).toEqual(['e2e-test', 'curl']);
    expect(n(null)).toEqual([]);
    expect(n(undefined)).toEqual([]);
    expect(n(42)).toEqual([]);
    expect(n({})).toEqual([]);
  });
});
