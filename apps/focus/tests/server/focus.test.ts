import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertInboxItem, insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  buildEmptyDays,
  distractImpl,
  endSessionImpl,
  endSchema,
  findApiClientImpl,
  getActiveSessionImpl,
  loadDaySessionsImpl,
  loadHistoryImpl,
  loadHomeImpl,
  startSchema,
  startSessionImpl,
} from '~/server/focus';
import { findUserBySsoImpl } from '~/server/users';

// ---------- schemas ----------

describe('startSchema', () => {
  it('rejects empty taskText', () => {
    expect(startSchema.safeParse({ taskText: '' }).success).toBe(false);
  });
  it('rejects targetMinutes above 180', () => {
    expect(startSchema.safeParse({ taskText: 'x', targetMinutes: 500 }).success).toBe(false);
  });
  it('rejects non-int targetMinutes', () => {
    expect(startSchema.safeParse({ taskText: 'x', targetMinutes: 25.5 }).success).toBe(false);
  });
  it('accepts a minimal valid payload (defaults targetMinutes)', () => {
    const r = startSchema.safeParse({ taskText: 'fix auth' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.targetMinutes).toBe(25);
  });
  it('accepts optional inboxItemId / pmIssueId', () => {
    const r = startSchema.safeParse({
      taskText: 'fix auth',
      targetMinutes: 45,
      inboxItemId: 99,
      pmIssueId: 7,
    });
    expect(r.success).toBe(true);
  });
});

describe('endSchema', () => {
  it('rejects unknown reason', () => {
    expect(endSchema.safeParse({ sessionId: 1, endedReason: 'nope' }).success).toBe(false);
  });
  it('rejects satisfaction out of range', () => {
    expect(
      endSchema.safeParse({ sessionId: 1, endedReason: 'completed', satisfaction: 6 }).success,
    ).toBe(false);
  });
  it('accepts a minimal completed payload', () => {
    expect(endSchema.safeParse({ sessionId: 1, endedReason: 'completed' }).success).toBe(true);
  });
});

// ---------- startSessionImpl ----------

describe('startSessionImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('inserts a session and derives endsAt = startedAt + targetMinutes', async () => {
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await startSessionImpl(db, userId, { taskText: 'fix auth', targetMinutes: 25 }, now);
    expect(typeof r.id).toBe('number');
    expect(r.startedAt.toISOString()).toBe(now.toISOString());
    expect(r.endsAt.getTime() - r.startedAt.getTime()).toBe(25 * 60_000);
  });

  it('closes any pre-existing active session as abandoned', async () => {
    const first = await startSessionImpl(db, userId, { taskText: 'first', targetMinutes: 25 });
    await startSessionImpl(db, userId, { taskText: 'second', targetMinutes: 25 });
    const rows = (await db.execute(
      sql`SELECT id, ended_reason, ended_at IS NOT NULL AS closed FROM focus.sessions WHERE id = ${first.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const row = list[0] as { ended_reason: string; closed: boolean };
    expect(row.ended_reason).toBe('abandoned');
    expect(row.closed).toBe(true);
  });

  it('persists inboxItemId + pmIssueId when provided', async () => {
    const r = await startSessionImpl(db, userId, {
      taskText: 'fix issue 7',
      targetMinutes: 25,
      inboxItemId: 42,
      pmIssueId: 7,
    });
    const rows = (await db.execute(
      sql`SELECT inbox_item_id, pm_issue_id FROM focus.sessions WHERE id = ${r.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const row = list[0] as { inbox_item_id: number; pm_issue_id: number };
    expect(Number(row.inbox_item_id)).toBe(42);
    expect(row.pm_issue_id).toBe(7);
  });
});

// ---------- endSessionImpl ----------

describe('endSessionImpl', () => {
  let db: TestDB;
  let userId: number;
  let sessionId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'bob' });
    userId = u.id;
    const r = await startSessionImpl(db, userId, { taskText: 'fix me', targetMinutes: 25 });
    sessionId = r.id;
  });

  it('completes a session and persists notes + satisfaction', async () => {
    const updated = await endSessionImpl(db, userId, {
      sessionId,
      endedReason: 'completed',
      notes: 'flow state',
      satisfaction: 5,
    });
    expect(updated?.endedReason).toBe('completed');
    const rows = (await db.execute(
      sql`SELECT notes, satisfaction FROM focus.sessions WHERE id = ${sessionId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const row = list[0] as { notes: string; satisfaction: number };
    expect(row.notes).toBe('flow state');
    expect(row.satisfaction).toBe(5);
  });

  it('abandons a session', async () => {
    const updated = await endSessionImpl(db, userId, { sessionId, endedReason: 'abandoned' });
    expect(updated?.endedReason).toBe('abandoned');
  });

  it('extends a session by +5 minutes WITHOUT ending it', async () => {
    const updated = await endSessionImpl(db, userId, { sessionId, endedReason: 'extended' });
    expect(updated?.endedReason).toBe('extended');
    const rows = (await db.execute(
      sql`SELECT target_minutes, ended_at FROM focus.sessions WHERE id = ${sessionId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const row = list[0] as { target_minutes: number; ended_at: string | null };
    expect(row.target_minutes).toBe(30);
    expect(row.ended_at).toBeNull();
  });

  it('returns null if the session does not belong to the user', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
    const updated = await endSessionImpl(db, other.id, { sessionId, endedReason: 'completed' });
    expect(updated).toBeNull();
  });

  it('returns null if the session is already ended', async () => {
    await endSessionImpl(db, userId, { sessionId, endedReason: 'completed' });
    const again = await endSessionImpl(db, userId, { sessionId, endedReason: 'abandoned' });
    expect(again).toBeNull();
  });

  it('returns null when extending a non-existent session', async () => {
    const updated = await endSessionImpl(db, userId, { sessionId: 99999, endedReason: 'extended' });
    expect(updated).toBeNull();
  });
});

// ---------- distractImpl ----------

describe('distractImpl', () => {
  let db: TestDB;
  let userId: number;
  let sessionId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
    const r = await startSessionImpl(db, userId, { taskText: 'fix me', targetMinutes: 25 });
    sessionId = r.id;
  });

  it('inserts a distraction against an owned session', async () => {
    const r = await distractImpl(db, userId, { sessionId, label: 'twitter' });
    expect(typeof r?.id).toBe('number');
    const rows = (await db.execute(
      sql`SELECT label, details FROM focus.distractions WHERE session_id = ${sessionId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect(list).toHaveLength(1);
    expect((list[0] as { label: string }).label).toBe('twitter');
  });

  it('persists optional details', async () => {
    await distractImpl(db, userId, {
      sessionId,
      label: 'random thought',
      details: 'remembered to buy oats',
    });
    const rows = (await db.execute(
      sql`SELECT details FROM focus.distractions WHERE session_id = ${sessionId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { details: string }).details).toBe('remembered to buy oats');
  });

  it('returns null when the session belongs to someone else', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
    const r = await distractImpl(db, other.id, { sessionId, label: 'twitter' });
    expect(r).toBeNull();
  });

  it('returns null when the session does not exist', async () => {
    const r = await distractImpl(db, userId, { sessionId: 99999, label: 'twitter' });
    expect(r).toBeNull();
  });
});

// ---------- getActiveSessionImpl ----------

describe('getActiveSessionImpl', () => {
  it('returns null when there is no active session', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await getActiveSessionImpl(db, u.id)).toBeNull();
  });

  it('returns the most recent active session with endsAt derived', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const now = new Date('2026-05-24T10:00:00Z');
    const r = await startSessionImpl(db, u.id, { taskText: 'fix auth', targetMinutes: 25 }, now);
    const active = await getActiveSessionImpl(db, u.id);
    expect(active).not.toBeNull();
    expect(active!.id).toBe(r.id);
    expect(active!.taskText).toBe('fix auth');
    expect(active!.endsAt).toBe(new Date(now.getTime() + 25 * 60_000).toISOString());
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

  it('reports active session, today stats, and inbox suggestions in one call', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    // Two completed sessions earlier today (1h focused), and an active one.
    const todayStart = new Date(Date.UTC(2026, 4, 24, 6, 0, 0));
    await startSessionImpl(db, u.id, { taskText: 'morning a', targetMinutes: 25 }, todayStart);
    await endSessionImpl(
      db,
      u.id,
      { sessionId: 1, endedReason: 'completed' },
      new Date(todayStart.getTime() + 25 * 60_000),
    );
    await startSessionImpl(
      db,
      u.id,
      { taskText: 'morning b', targetMinutes: 25 },
      new Date(todayStart.getTime() + 30 * 60_000),
    );
    await endSessionImpl(
      db,
      u.id,
      { sessionId: 2, endedReason: 'completed' },
      new Date(todayStart.getTime() + 60 * 60_000),
    );
    const activeStart = new Date(todayStart.getTime() + 90 * 60_000);
    const active = await startSessionImpl(
      db,
      u.id,
      { taskText: 'now thing', targetMinutes: 45 },
      activeStart,
    );
    // Log a wobble against the active session so the today counter > 0.
    await distractImpl(db, u.id, { sessionId: active.id, label: 'slack' });
    // Seed inbox.items for the autocomplete.
    await insertInboxItem(db, u.id, 'refill meds');
    await insertInboxItem(db, u.id, 'review PR #42');

    const home = await loadHomeImpl(
      db,
      'sso-alice',
      new Date(todayStart.getTime() + 120 * 60_000),
    );
    expect(home).not.toBeNull();
    expect(home!.me.login).toBe('alice');
    expect(home!.active?.taskText).toBe('now thing');
    expect(home!.active?.targetMinutes).toBe(45);
    expect(home!.todayFocusedMinutes).toBe(50); // two completed × 25
    expect(home!.todaySessionsCount).toBe(3);
    expect(home!.todayDistractionCount).toBe(1);
    expect(home!.inboxSuggestions.map((s) => s.text).sort()).toEqual([
      'refill meds',
      'review PR #42',
    ]);
  });

  it('preselects the last abandoned task text for cheap re-entry', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const t0 = new Date('2026-05-24T09:00:00Z');
    const a = await startSessionImpl(db, u.id, { taskText: 'fix auth bug', targetMinutes: 25 }, t0);
    await endSessionImpl(
      db,
      u.id,
      { sessionId: a.id, endedReason: 'abandoned' },
      new Date(t0.getTime() + 60_000),
    );
    const home = await loadHomeImpl(db, 'sso-alice', new Date(t0.getTime() + 120_000));
    expect(home!.lastAbandonedTaskText).toBe('fix auth bug');
    expect(home!.active).toBeNull();
  });

  it('soft-fails when inbox.items does not exist on this DB', async () => {
    const db = await makeTestDb({ withInbox: false });
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const home = await loadHomeImpl(db, 'sso-alice');
    expect(home).not.toBeNull();
    expect(home!.inboxSuggestions).toEqual([]);
  });
});

// ---------- loadHistoryImpl ----------

describe('buildEmptyDays', () => {
  it('returns exactly 90 contiguous days, oldest first', () => {
    const now = new Date(2026, 4, 24); // local
    const days = buildEmptyDays(now, 90);
    expect(days).toHaveLength(90);
    expect(days.every((d) => d.minutes === 0)).toBe(true);
    expect(days.every((d) => d.sessions === 0)).toBe(true);
    // last entry == today
    expect(days[89]!.date).toBe('2026-05-24');
  });
  it('supports a custom day count', () => {
    expect(buildEmptyDays(new Date(2026, 4, 24), 7)).toHaveLength(7);
  });
});

describe('loadHistoryImpl', () => {
  it('returns null when sub is missing', async () => {
    const db = await makeTestDb();
    expect(await loadHistoryImpl(db, null)).toBeNull();
  });

  it('returns null when sub does not map', async () => {
    const db = await makeTestDb();
    expect(await loadHistoryImpl(db, 'nope')).toBeNull();
  });

  it('counts completed minutes per day and pads the rest of the 90-day window', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice', sub: 'sso-alice' });
    const t0 = new Date('2026-05-23T10:00:00Z'); // yesterday
    const r = await startSessionImpl(db, u.id, { taskText: 'a', targetMinutes: 25 }, t0);
    await endSessionImpl(
      db,
      u.id,
      { sessionId: r.id, endedReason: 'completed' },
      new Date(t0.getTime() + 25 * 60_000),
    );
    // Also create an abandoned one — it should count as a session but
    // contribute 0 minutes.
    const r2 = await startSessionImpl(
      db,
      u.id,
      { taskText: 'b', targetMinutes: 25 },
      new Date(t0.getTime() + 60 * 60_000),
    );
    await endSessionImpl(
      db,
      u.id,
      { sessionId: r2.id, endedReason: 'abandoned' },
      new Date(t0.getTime() + 65 * 60_000),
    );

    const now = new Date('2026-05-24T12:00:00Z');
    const hist = await loadHistoryImpl(db, 'sso-alice', now);
    expect(hist).not.toBeNull();
    expect(hist!.days).toHaveLength(90);
    expect(hist!.totalSessions).toBe(2);
    expect(hist!.totalMinutes).toBe(25); // only the completed one
    const yesterday = hist!.days.find((d) => d.date === '2026-05-23');
    expect(yesterday?.minutes).toBe(25);
    expect(yesterday?.sessions).toBe(2);
  });
});

// ---------- loadDaySessionsImpl ----------

describe('loadDaySessionsImpl', () => {
  it('returns [] for a bad YMD string (no SQL smuggling)', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await loadDaySessionsImpl(db, u.id, "2026-01-01'; DROP TABLE")).toEqual([]);
  });

  it('returns the user\'s sessions for a given day with distraction counts', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const t0 = new Date('2026-05-23T10:00:00Z');
    const r = await startSessionImpl(db, u.id, { taskText: 'a', targetMinutes: 25 }, t0);
    await distractImpl(db, u.id, { sessionId: r.id, label: 'twitter' });
    await distractImpl(db, u.id, { sessionId: r.id, label: 'slack' });
    await endSessionImpl(
      db,
      u.id,
      { sessionId: r.id, endedReason: 'completed', notes: 'good', satisfaction: 4 },
      new Date(t0.getTime() + 25 * 60_000),
    );
    const rows = await loadDaySessionsImpl(db, u.id, '2026-05-23');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.distractionCount).toBe(2);
    expect(rows[0]!.notes).toBe('good');
    expect(rows[0]!.satisfaction).toBe(4);
    expect(rows[0]!.endedReason).toBe('completed');
  });

  it('does not leak sessions from other users', async () => {
    const db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    const bob = await insertPmUser(db, { login: 'bob', sub: 'sso-bob' });
    const t0 = new Date('2026-05-23T10:00:00Z');
    await startSessionImpl(db, alice.id, { taskText: 'alice thing', targetMinutes: 25 }, t0);
    const rows = await loadDaySessionsImpl(db, bob.id, '2026-05-23');
    expect(rows).toEqual([]);
  });
});

// ---------- findApiClientImpl ----------

describe('findApiClientImpl', () => {
  it('finds a row by client_id, returns null otherwise', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await db.execute(sql`
      INSERT INTO focus.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', 'secret-xyz', ${u.id})
    `);
    const found = await findApiClientImpl(db, 'cli');
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
