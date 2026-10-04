import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import {
  applyTriageImpl,
  captureImpl,
  captureSchema,
  findApiClientImpl,
  loadTriageImpl,
} from '~/server/inbox';
import { findUserBySsoImpl } from '~/server/users';

describe('captureImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts an item with text + defaults', async () => {
    const r = await captureImpl(db, userId, { text: 'remember to refill meds' });
    expect(typeof r.id).toBe('number');
    expect(r.capturedAt).toBeInstanceOf(Date);
    const rows = (await db.execute(
      sql`SELECT user_id, text, status, source, tags FROM inbox.items WHERE id = ${r.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect(list).toHaveLength(1);
    const row = list[0] as {
      user_id: number;
      text: string;
      status: string;
      source: string | null;
      tags: string[];
    };
    expect(row.user_id).toBe(userId);
    expect(row.text).toBe('remember to refill meds');
    expect(row.status).toBe('unread');
    expect(row.source).toBeNull();
    expect(row.tags).toEqual([]);
  });

  it('persists source + tags when provided', async () => {
    const r = await captureImpl(db, userId, {
      text: 'idea: stash to R2',
      source: 'cli',
      tags: ['idea', 'stash'],
    });
    const rows = (await db.execute(
      sql`SELECT source, tags FROM inbox.items WHERE id = ${r.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { source: string; tags: string[] }).source).toBe('cli');
    expect((list[0] as { source: string; tags: string[] }).tags).toEqual(['idea', 'stash']);
  });
});

describe('captureSchema', () => {
  it('rejects empty text', () => {
    expect(captureSchema.safeParse({ text: '' }).success).toBe(false);
  });
  it('rejects unknown source', () => {
    expect(captureSchema.safeParse({ text: 'x', source: 'nope' }).success).toBe(false);
  });
  it('rejects too many tags', () => {
    const tags = Array.from({ length: 33 }, (_, i) => `t${i}`);
    expect(captureSchema.safeParse({ text: 'x', tags }).success).toBe(false);
  });
  it('accepts a minimal valid payload', () => {
    const r = captureSchema.safeParse({ text: 'hello' });
    expect(r.success).toBe(true);
  });
});

describe('loadTriageImpl', () => {
  let db: TestDB;
  let aliceSub: string;
  let aliceId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    aliceSub = u.sub;
    aliceId = u.id;
  });

  it('returns null when sub is missing', async () => {
    expect(await loadTriageImpl(db, null)).toBeNull();
  });

  it('returns null when sub does not map to a pm.users row', async () => {
    expect(await loadTriageImpl(db, 'nope')).toBeNull();
  });

  it('returns grouped buckets, drops "dropped" items', async () => {
    // Seed 1 pinned, 2 unread, 1 done, 1 dropped, 1 snoozed.
    await captureImpl(db, aliceId, { text: 'pinned thing' });
    await captureImpl(db, aliceId, { text: 'unread 1' });
    await captureImpl(db, aliceId, { text: 'unread 2' });
    await captureImpl(db, aliceId, { text: 'done thing' });
    await captureImpl(db, aliceId, { text: 'dropped thing' });
    await captureImpl(db, aliceId, { text: 'snoozed thing' });
    const ids = (await db.execute(
      sql`SELECT id, text FROM inbox.items WHERE user_id = ${aliceId} ORDER BY id`,
    )) as unknown;
    const list = (Array.isArray(ids) ? ids : (ids as { rows?: unknown[] }).rows ?? []) as Array<{
      id: number;
      text: string;
    }>;
    const byText = new Map(list.map((r) => [r.text, r.id]));
    // promote some via applyTriageImpl
    await applyTriageImpl(db, aliceId, { id: byText.get('pinned thing')!, action: 'pin' });
    await applyTriageImpl(db, aliceId, { id: byText.get('done thing')!, action: 'done' });
    await applyTriageImpl(db, aliceId, { id: byText.get('dropped thing')!, action: 'drop' });
    await applyTriageImpl(db, aliceId, { id: byText.get('snoozed thing')!, action: 'snooze1d' });

    const payload = await loadTriageImpl(db, aliceSub);
    expect(payload).not.toBeNull();
    expect(payload!.me.login).toBe('alice');
    expect(payload!.pinned.map((i) => i.text)).toEqual(['pinned thing']);
    expect(payload!.unread.map((i) => i.text).sort()).toEqual(['unread 1', 'unread 2']);
    expect(payload!.done.map((i) => i.text)).toEqual(['done thing']);
    expect(payload!.snoozed.map((i) => i.text)).toEqual(['snoozed thing']);
    // dropped never appears
    expect(JSON.stringify(payload)).not.toContain('dropped thing');
  });
});

describe('applyTriageImpl', () => {
  let db: TestDB;
  let userId: number;
  let itemId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'bob' });
    userId = u.id;
    const r = await captureImpl(db, userId, { text: 'thing' });
    itemId = r.id;
  });

  it('pin', async () => {
    const r = await applyTriageImpl(db, userId, { id: itemId, action: 'pin' });
    expect(r?.status).toBe('pinned');
  });
  it('unread (resets pin)', async () => {
    await applyTriageImpl(db, userId, { id: itemId, action: 'pin' });
    const r = await applyTriageImpl(db, userId, { id: itemId, action: 'unread' });
    expect(r?.status).toBe('unread');
  });
  it('done', async () => {
    const r = await applyTriageImpl(db, userId, { id: itemId, action: 'done' });
    expect(r?.status).toBe('done');
  });
  it('drop', async () => {
    const r = await applyTriageImpl(db, userId, { id: itemId, action: 'drop' });
    expect(r?.status).toBe('dropped');
  });
  it('snooze1d sets snoozed_until ≈ now+1d', async () => {
    const now = new Date('2026-05-23T00:00:00Z');
    const r = await applyTriageImpl(db, userId, { id: itemId, action: 'snooze1d' }, now);
    expect(r?.status).toBe('snoozed');
    const rows = (await db.execute(
      sql`SELECT snoozed_until FROM inbox.items WHERE id = ${itemId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const su = new Date((list[0] as { snoozed_until: string }).snoozed_until).getTime();
    expect(su - now.getTime()).toBe(24 * 60 * 60 * 1000);
  });
  it('snooze1w sets snoozed_until ≈ now+7d', async () => {
    const now = new Date('2026-05-23T00:00:00Z');
    const r = await applyTriageImpl(db, userId, { id: itemId, action: 'snooze1w' }, now);
    expect(r?.status).toBe('snoozed');
    const rows = (await db.execute(
      sql`SELECT snoozed_until FROM inbox.items WHERE id = ${itemId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const su = new Date((list[0] as { snoozed_until: string }).snoozed_until).getTime();
    expect(su - now.getTime()).toBe(7 * 24 * 60 * 60 * 1000);
  });
  it('refile_pm_placeholder marks done + stamps refiled_to', async () => {
    const r = await applyTriageImpl(db, userId, { id: itemId, action: 'refile_pm_placeholder' });
    expect(r?.status).toBe('done');
    const rows = (await db.execute(
      sql`SELECT refiled_to FROM inbox.items WHERE id = ${itemId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { refiled_to: Record<string, unknown> }).refiled_to).toEqual({
      app: 'pm',
      placeholder: true,
    });
  });
  it('returns null when item belongs to another user', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
    const r = await applyTriageImpl(db, other.id, { id: itemId, action: 'pin' });
    expect(r).toBeNull();
  });
});

describe('findApiClientImpl', () => {
  it('finds a row by client_id, returns null otherwise', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await db.execute(sql`
      INSERT INTO inbox.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', 'secret-xyz', ${u.id})
    `);
    const found = await findApiClientImpl(db, 'cli');
    expect(found).not.toBeNull();
    expect(found!.name).toBe('CLI');
    expect(found!.userId).toBe(u.id);
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});

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
