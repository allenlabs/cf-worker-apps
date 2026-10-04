import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  deleteSnapshotImpl,
  findApiClientImpl,
  getSnapshotImpl,
  listSnapshotsImpl,
  loadHomeImpl,
  restoreSnapshotImpl,
  saveSchema,
  saveSnapshotImpl,
  listQuerySchema,
} from '~/server/context';
import { findUserBySsoImpl } from '~/server/users';

// ---------- schemas ----------

describe('saveSchema', () => {
  it('rejects empty name', () => {
    expect(saveSchema.safeParse({ name: '', payload: {} }).success).toBe(false);
  });
  it('rejects name > 200 chars', () => {
    expect(saveSchema.safeParse({ name: 'a'.repeat(201), payload: {} }).success).toBe(false);
  });
  it('rejects payload > 256 KB', () => {
    const big = { blob: 'x'.repeat(300_000) };
    expect(saveSchema.safeParse({ name: 'x', payload: big }).success).toBe(false);
  });
  it('accepts the minimal valid payload (defaults payload = {})', () => {
    const r = saveSchema.safeParse({ name: 'fixing auth' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.payload).toEqual({});
  });
  it('accepts optional notes + linked entity ids', () => {
    const r = saveSchema.safeParse({
      name: 'x',
      notes: 'note',
      payload: { cwd: '/tmp' },
      focusSessionId: 1,
      pmIssueId: 7,
      inboxItemId: 42,
    });
    expect(r.success).toBe(true);
  });
});

describe('listQuerySchema', () => {
  it('defaults limit to 20', () => {
    const r = listQuerySchema.parse({});
    expect(r.limit).toBe(20);
  });
  it('rejects non-int limit', () => {
    expect(listQuerySchema.safeParse({ limit: 1.5 }).success).toBe(false);
  });
  it('rejects limit > 100', () => {
    expect(listQuerySchema.safeParse({ limit: 1000 }).success).toBe(false);
  });
});

// ---------- saveSnapshotImpl ----------

describe('saveSnapshotImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts a snapshot and returns the row', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await saveSnapshotImpl(
      db,
      userId,
      { name: 'fixing auth', payload: { cwd: '/home/me' } },
      now,
    );
    expect(typeof r.id).toBe('number');
    expect(r.name).toBe('fixing auth');
    expect(r.createdAt.toISOString()).toBe(now.toISOString());
  });

  it('persists notes + soft-FKs when provided', async () => {
    const r = await saveSnapshotImpl(db, userId, {
      name: 'x',
      notes: 'careful, half-way through',
      payload: { branch: 'fix/auth' },
      focusSessionId: 1,
      pmIssueId: 7,
      inboxItemId: 42,
    });
    const rows = (await db.execute(
      sql`SELECT notes, payload, focus_session_id, pm_issue_id, inbox_item_id
          FROM context.snapshots WHERE id = ${r.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const row = list[0] as {
      notes: string;
      payload: Record<string, unknown>;
      focus_session_id: number;
      pm_issue_id: number;
      inbox_item_id: number;
    };
    expect(row.notes).toBe('careful, half-way through');
    expect(row.payload).toEqual({ branch: 'fix/auth' });
    expect(Number(row.focus_session_id)).toBe(1);
    expect(row.pm_issue_id).toBe(7);
    expect(Number(row.inbox_item_id)).toBe(42);
  });

  it('defaults empty payload to "{}" jsonb', async () => {
    const r = await saveSnapshotImpl(db, userId, { name: 'x', payload: {} });
    const rows = (await db.execute(
      sql`SELECT payload FROM context.snapshots WHERE id = ${r.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { payload: Record<string, unknown> }).payload).toEqual({});
  });
});

// ---------- listSnapshotsImpl ----------

describe('listSnapshotsImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('returns [] when the user has no snapshots', async () => {
    expect(await listSnapshotsImpl(db, userId)).toEqual([]);
  });

  it('returns the user\'s rows in created_at DESC order', async () => {
    const t0 = new Date('2026-05-24T09:00:00Z');
    await saveSnapshotImpl(db, userId, { name: 'old', payload: {} }, t0);
    await saveSnapshotImpl(
      db,
      userId,
      { name: 'newer', payload: {} },
      new Date(t0.getTime() + 60_000),
    );
    const rows = await listSnapshotsImpl(db, userId);
    expect(rows.map((r) => r.name)).toEqual(['newer', 'old']);
  });

  it('flags hasCwd / hasBranch based on payload keys', async () => {
    await saveSnapshotImpl(db, userId, {
      name: 'a',
      payload: { cwd: '/x', branch: 'main' },
    });
    await saveSnapshotImpl(db, userId, { name: 'b', payload: { other: 1 } });
    const rows = await listSnapshotsImpl(db, userId);
    const a = rows.find((r) => r.name === 'a')!;
    const b = rows.find((r) => r.name === 'b')!;
    expect(a.hasCwd).toBe(true);
    expect(a.hasBranch).toBe(true);
    expect(b.hasCwd).toBe(false);
    expect(b.hasBranch).toBe(false);
  });

  it('honours a custom limit, capped at 100', async () => {
    for (let i = 0; i < 3; i++) {
      await saveSnapshotImpl(db, userId, { name: `n${i}`, payload: {} });
    }
    expect((await listSnapshotsImpl(db, userId, 2)).length).toBe(2);
    // Pathological limit gets clamped, not rejected.
    expect(Array.isArray(await listSnapshotsImpl(db, userId, 0))).toBe(true);
    expect(Array.isArray(await listSnapshotsImpl(db, userId, 9999))).toBe(true);
  });

  it('does not leak other users\' snapshots', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
    await saveSnapshotImpl(db, other.id, { name: 'mallory thing', payload: {} });
    const rows = await listSnapshotsImpl(db, userId);
    expect(rows).toEqual([]);
  });
});

// ---------- getSnapshotImpl ----------

describe('getSnapshotImpl', () => {
  it('returns the snapshot for the owning user', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnapshotImpl(db, u.id, {
      name: 'fix auth',
      notes: 'careful',
      payload: { cwd: '/x', branch: 'main', files: ['a.ts', 'b.ts'] },
    });
    const got = await getSnapshotImpl(db, u.id, r.id);
    expect(got?.name).toBe('fix auth');
    expect(got?.notes).toBe('careful');
    expect(got?.payload).toEqual({ cwd: '/x', branch: 'main', files: ['a.ts', 'b.ts'] });
    expect(got?.restoredCount).toBe(0);
    expect(got?.restoredAt).toBeNull();
  });

  it('returns null when the id belongs to another user', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const r = await saveSnapshotImpl(db, alice.id, { name: 'a', payload: {} });
    expect(await getSnapshotImpl(db, bob.id, r.id)).toBeNull();
  });

  it('returns null when the id does not exist', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await getSnapshotImpl(db, u.id, 99999)).toBeNull();
  });

  it('surfaces linked-entity ids when present', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnapshotImpl(db, u.id, {
      name: 'linked',
      payload: { cwd: '/x' },
      focusSessionId: 11,
      pmIssueId: 22,
      inboxItemId: 33,
    });
    const got = await getSnapshotImpl(db, u.id, r.id);
    expect(got?.focusSessionId).toBe(11);
    expect(got?.pmIssueId).toBe(22);
    expect(got?.inboxItemId).toBe(33);
  });
});

// ---------- restoreSnapshotImpl ----------

describe('restoreSnapshotImpl', () => {
  it('bumps restored_at + restored_count and returns the row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnapshotImpl(db, u.id, {
      name: 'fix auth',
      payload: { cwd: '/x' },
    });
    const now = new Date('2026-05-24T11:00:00Z');
    const got = await restoreSnapshotImpl(db, u.id, r.id, now);
    expect(got?.restoredCount).toBe(1);
    expect(got?.restoredAt).toBe(now.toISOString());

    const again = await restoreSnapshotImpl(
      db,
      u.id,
      r.id,
      new Date('2026-05-24T11:05:00Z'),
    );
    expect(again?.restoredCount).toBe(2);
  });

  it('returns null when the snapshot belongs to another user', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const r = await saveSnapshotImpl(db, alice.id, { name: 'a', payload: {} });
    expect(await restoreSnapshotImpl(db, bob.id, r.id)).toBeNull();
  });

  it('returns null when the snapshot does not exist', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await restoreSnapshotImpl(db, u.id, 99999)).toBeNull();
  });

  it('surfaces linked-entity ids in the post-bump row', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnapshotImpl(db, u.id, {
      name: 'linked',
      payload: {},
      focusSessionId: 11,
      pmIssueId: 22,
      inboxItemId: 33,
    });
    const got = await restoreSnapshotImpl(db, u.id, r.id);
    expect(got?.focusSessionId).toBe(11);
    expect(got?.pmIssueId).toBe(22);
    expect(got?.inboxItemId).toBe(33);
  });
});

// ---------- deleteSnapshotImpl ----------

describe('deleteSnapshotImpl', () => {
  it('deletes the user\'s snapshot', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const r = await saveSnapshotImpl(db, u.id, { name: 'a', payload: {} });
    expect(await deleteSnapshotImpl(db, u.id, r.id)).toBe(true);
    expect(await getSnapshotImpl(db, u.id, r.id)).toBeNull();
  });

  it('returns false when the snapshot belongs to another user', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const r = await saveSnapshotImpl(db, alice.id, { name: 'a', payload: {} });
    expect(await deleteSnapshotImpl(db, bob.id, r.id)).toBe(false);
    // Still there, owned by alice
    expect(await getSnapshotImpl(db, alice.id, r.id)).not.toBeNull();
  });

  it('returns false when the snapshot does not exist', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await deleteSnapshotImpl(db, u.id, 99999)).toBe(false);
  });
});

// ---------- loadHomeImpl ----------

describe('loadHomeImpl', () => {
  it('returns null when sub is missing', async () => {
    const db = await makeTestDb();
    expect(await loadHomeImpl(db, null)).toBeNull();
  });

  it('returns null when sub does not map to a pm.users row', async () => {
    const db = await makeTestDb();
    expect(await loadHomeImpl(db, 'nope')).toBeNull();
  });

  it('returns me + most-recent snapshots in one round-trip', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    await saveSnapshotImpl(db, u.id, { name: 'oldest', payload: {} }, t0);
    await saveSnapshotImpl(
      db,
      u.id,
      { name: 'middle', payload: { cwd: '/x' } },
      new Date(t0.getTime() + 60_000),
    );
    await saveSnapshotImpl(
      db,
      u.id,
      { name: 'newest', payload: { cwd: '/y', branch: 'main' } },
      new Date(t0.getTime() + 120_000),
    );
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home?.me.login).toBe('alice');
    expect(home?.snapshots.map((s) => s.name)).toEqual(['newest', 'middle', 'oldest']);
    const newest = home!.snapshots[0]!;
    expect(newest.hasCwd).toBe(true);
    expect(newest.hasBranch).toBe(true);
    expect(newest.restoredCount).toBe(0);
  });

  it('honours a custom limit', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    for (let i = 0; i < 5; i++) {
      await saveSnapshotImpl(db, u.id, { name: `n${i}`, payload: {} });
    }
    const home = await loadHomeImpl(db, 'sso-alice', 2);
    expect(home?.snapshots.length).toBe(2);
  });
});

// ---------- findApiClientImpl ----------

describe('findApiClientImpl', () => {
  it('finds a row by client_id, returns null otherwise', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await db.execute(sql`
      INSERT INTO context.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli-test', 'CLI', 'secret-xyz', ${u.id})
    `);
    const found = await findApiClientImpl(db, 'cli-test');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('CLI');
    expect(found!.userId).toBe(u.id);
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});

// ---------- findUserBySsoImpl ----------

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
    expect(await findUserBySsoImpl(db, 'unknown-sub')).toBeNull();
  });
});
