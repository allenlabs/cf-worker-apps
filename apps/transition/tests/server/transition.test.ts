import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  _testing,
  createApiClientImpl,
  createApiClientSchema,
  deleteApiClientImpl,
  findApiClientImpl,
  listApiClientsImpl,
  listRecentImpl,
  loadHomeImpl,
  saveRitualImpl,
  saveRitualSchema,
} from '~/server/transition';
import { findUserBySsoImpl } from '~/server/users';

describe('saveRitualSchema', () => {
  it('accepts a minimal payload', () => {
    expect(
      saveRitualSchema.safeParse({
        leaving_at: 'finished the audit',
        next_step: 'add tests',
      }).success,
    ).toBe(true);
  });
  it('rejects empty leaving_at', () => {
    expect(saveRitualSchema.safeParse({ leaving_at: '', next_step: 'x' }).success).toBe(false);
  });
  it('rejects empty next_step', () => {
    expect(saveRitualSchema.safeParse({ leaving_at: 'x', next_step: '' }).success).toBe(false);
  });
  it('rejects bad target', () => {
    expect(
      saveRitualSchema.safeParse({
        leaving_at: 'x', next_step: 'y', target: 'nope',
      }).success,
    ).toBe(false);
  });
  it('accepts each valid target', () => {
    for (const t of ['context', 'inbox', 'journal'] as const) {
      expect(
        saveRitualSchema.safeParse({ leaving_at: 'x', next_step: 'y', target: t }).success,
      ).toBe(true);
    }
  });
  it('rejects > 4000-char fields', () => {
    expect(
      saveRitualSchema.safeParse({ leaving_at: 'x'.repeat(4001), next_step: 'y' }).success,
    ).toBe(false);
  });
  it('accepts null might_forget / target', () => {
    expect(
      saveRitualSchema.safeParse({
        leaving_at: 'x', next_step: 'y', might_forget: null, target: null,
      }).success,
    ).toBe(true);
  });
});

describe('saveRitualImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts a fresh ritual', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await saveRitualImpl(
      db,
      userId,
      { leaving_at: 'audit done', next_step: 'PR review' },
      now,
    );
    expect(r.leavingAt).toBe('audit done');
    expect(r.nextStep).toBe('PR review');
    expect(r.target).toBeNull();
    expect(r.createdAt).toBe('2026-05-24T10:00:00.000Z');
  });

  it('persists might_forget + target', async () => {
    const r = await saveRitualImpl(db, userId, {
      leaving_at: 'leaving',
      next_step: 'next',
      might_forget: 'the cache TTL',
      target: 'inbox',
    });
    expect(r.mightForget).toBe('the cache TTL');
    expect(r.target).toBe('inbox');
  });

  it('null target stored as null', async () => {
    const r = await saveRitualImpl(db, userId, {
      leaving_at: 'x',
      next_step: 'y',
      target: null,
    });
    expect(r.target).toBeNull();
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
      await saveRitualImpl(
        db,
        userId,
        { leaving_at: `state ${i}`, next_step: `next ${i}` },
        new Date(base + i * 60_000),
      );
    }
  });

  it('returns DESC by created_at', async () => {
    const list = await listRecentImpl(db, userId);
    expect(list.map((r) => r.leavingAt)).toEqual([
      'state 4', 'state 3', 'state 2', 'state 1', 'state 0',
    ]);
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
    await saveRitualImpl(db, u.id, { leaving_at: 'l', next_step: 'n' });
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
      INSERT INTO transition.api_clients (client_id, name, hmac_secret, user_id)
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
    await db.execute(sql`DELETE FROM transition.api_clients`);
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
  });
  it('null for unknown sub', async () => {
    expect(await findUserBySsoImpl(await makeTestDb(), 'nope')).toBeNull();
  });
});

describe('_testing helpers', () => {
  it('toIso', () => {
    expect(_testing.toIso(new Date('2026-05-24T10:00:00Z'))).toBe('2026-05-24T10:00:00.000Z');
    expect(_testing.toIso('2026-05-24T10:00:00Z')).toBe('2026-05-24T10:00:00.000Z');
  });
  it('rowToRitual fallback defaults', () => {
    const r = _testing.rowToRitual({ id: 1, createdAt: '2026-05-24T10:00:00Z' });
    expect(r.leavingAt).toBe('');
    expect(r.nextStep).toBe('');
    expect(r.mightForget).toBeNull();
    expect(r.target).toBeNull();
  });
});
