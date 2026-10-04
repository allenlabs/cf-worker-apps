import { describe, expect, it, beforeEach, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import { makeTestEnv } from '../_setup/env';
import {
  DEFAULT_PREFERENCES,
  getPreferencesImpl,
  inQuietHours,
  registerSubscriptionImpl,
  removeSubscriptionImpl,
  sendCaptureNotificationImpl,
  setPreferencesImpl,
  type PushTransport,
} from '~/server/push';

// ---------- Test helpers ----------

interface MockTransportOpts {
  responder?: (
    endpoint: string,
  ) =>
    | { ok: true }
    | { ok: false; gone?: boolean; statusCode?: number }
    | 'throw';
}

function makeMockTransport(opts: MockTransportOpts = {}): {
  transport: PushTransport;
  calls: Array<{ endpoint: string; title: string; body: string; tag?: string }>;
} {
  const calls: Array<{ endpoint: string; title: string; body: string; tag?: string }> = [];
  const responder =
    opts.responder ?? (() => ({ ok: true as const, gone: false, statusCode: 201 }));
  const transport: PushTransport = {
    async send(rendered, _ctx) {
      const ep = rendered.to.endpoint;
      calls.push({ endpoint: ep, title: rendered.title, body: rendered.body, tag: rendered.tag });
      const r = responder(ep);
      if (r === 'throw') throw new Error('transport-explode');
      if (r.ok) {
        return {
          ok: true,
          data: {
            results: [{ endpoint: ep, ok: true, statusCode: 201 }],
          },
        };
      }
      return {
        ok: true,
        data: {
          results: [
            {
              endpoint: ep,
              ok: false,
              gone: r.gone === true,
              statusCode: r.statusCode ?? 500,
            },
          ],
        },
      };
    },
  };
  return { transport, calls };
}

async function seedSubscription(
  db: TestDB,
  userId: number,
  endpoint: string,
  opts: { failedCount?: number; p256dh?: string; auth?: string } = {},
): Promise<number> {
  const r = (await db.execute(
    sql`
      INSERT INTO inbox.push_subscriptions
        (user_id, endpoint, p256dh, auth, failed_count)
      VALUES (${userId}, ${endpoint}, ${opts.p256dh ?? 'p256dh-x'}, ${opts.auth ?? 'auth-x'}, ${opts.failedCount ?? 0})
      RETURNING id
    `,
  )) as unknown;
  const rows = Array.isArray(r) ? r : (r as { rows?: unknown[] }).rows ?? [];
  return (rows[0] as { id: number }).id;
}

// ---------- Tests ----------

describe('registerSubscriptionImpl', () => {
  it('inserts a fresh subscription', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const out = await registerSubscriptionImpl(
      db,
      u.id,
      { endpoint: 'https://push.example/a', keys: { p256dh: 'pp', auth: 'aa' } },
      'TestAgent/1.0',
    );
    expect(typeof out.id).toBe('number');
    const rows = (await db.execute(
      sql`SELECT user_id, endpoint, p256dh, auth, user_agent, failed_count FROM inbox.push_subscriptions WHERE id = ${out.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const row = list[0] as {
      user_id: number;
      endpoint: string;
      p256dh: string;
      auth: string;
      user_agent: string;
      failed_count: number;
    };
    expect(row.user_id).toBe(u.id);
    expect(row.endpoint).toBe('https://push.example/a');
    expect(row.p256dh).toBe('pp');
    expect(row.auth).toBe('aa');
    expect(row.user_agent).toBe('TestAgent/1.0');
    expect(row.failed_count).toBe(0);
  });

  it('upserts on endpoint conflict, resets failed_count, updates keys', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await registerSubscriptionImpl(
      db,
      u.id,
      { endpoint: 'https://push.example/a', keys: { p256dh: 'old', auth: 'old' } },
      'AgentA',
    );
    // Bump failed_count manually so we can prove the upsert resets it.
    await db.execute(sql`UPDATE inbox.push_subscriptions SET failed_count = 7 WHERE endpoint = 'https://push.example/a'`);
    const out = await registerSubscriptionImpl(
      db,
      u.id,
      { endpoint: 'https://push.example/a', keys: { p256dh: 'new', auth: 'new' } },
      'AgentB',
    );
    expect(typeof out.id).toBe('number');
    const rows = (await db.execute(
      sql`SELECT p256dh, auth, user_agent, failed_count FROM inbox.push_subscriptions WHERE endpoint = 'https://push.example/a'`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect(list).toHaveLength(1);
    const row = list[0] as {
      p256dh: string;
      auth: string;
      user_agent: string;
      failed_count: number;
    };
    expect(row.p256dh).toBe('new');
    expect(row.auth).toBe('new');
    expect(row.user_agent).toBe('AgentB');
    expect(row.failed_count).toBe(0);
  });
});

describe('removeSubscriptionImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
    await seedSubscription(db, userId, 'https://push.example/a');
  });

  it('deletes the caller`s row by endpoint', async () => {
    const out = await removeSubscriptionImpl(db, userId, 'https://push.example/a');
    expect(out.removed).toBe(1);
  });

  it('does not delete another user`s row with the same endpoint', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mal' });
    const out = await removeSubscriptionImpl(db, other.id, 'https://push.example/a');
    expect(out.removed).toBe(0);
    // Confirm the original still exists.
    const rows = (await db.execute(
      sql`SELECT id FROM inbox.push_subscriptions WHERE endpoint = 'https://push.example/a'`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect(list).toHaveLength(1);
  });

  it('returns removed=0 when nothing matches', async () => {
    const out = await removeSubscriptionImpl(db, userId, 'https://does-not-exist');
    expect(out.removed).toBe(0);
  });
});

describe('preferences round-trip', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('returns defaults when no row exists', async () => {
    const p = await getPreferencesImpl(db, userId);
    expect(p).toEqual({ userId, ...DEFAULT_PREFERENCES });
  });

  it('writes and reads back', async () => {
    const out = await setPreferencesImpl(db, userId, {
      onCapture: false,
      quietStart: 22 * 60,
      quietEnd: 6 * 60,
    });
    expect(out).toEqual({
      userId,
      onCapture: false,
      quietStart: 22 * 60,
      quietEnd: 6 * 60,
    });
    const fetched = await getPreferencesImpl(db, userId);
    expect(fetched).toEqual(out);
  });

  it('preserves existing fields under partial updates', async () => {
    await setPreferencesImpl(db, userId, { onCapture: false, quietStart: 60, quietEnd: 120 });
    const out = await setPreferencesImpl(db, userId, { quietStart: 90 });
    expect(out).toEqual({ userId, onCapture: false, quietStart: 90, quietEnd: 120 });
  });

  it('null clears quiet hours; undefined keeps them', async () => {
    await setPreferencesImpl(db, userId, { quietStart: 60, quietEnd: 120 });
    const out = await setPreferencesImpl(db, userId, { quietEnd: null });
    expect(out.quietStart).toBe(60);
    expect(out.quietEnd).toBeNull();
  });
});

describe('inQuietHours', () => {
  const base = { userId: 1, onCapture: true } as const;

  it('returns false when bounds missing', () => {
    expect(inQuietHours({ ...base, quietStart: null, quietEnd: null })).toBe(false);
    expect(inQuietHours({ ...base, quietStart: 60, quietEnd: null })).toBe(false);
    expect(inQuietHours({ ...base, quietStart: null, quietEnd: 60 })).toBe(false);
  });
  it('returns false when start == end', () => {
    expect(
      inQuietHours(
        { ...base, quietStart: 480, quietEnd: 480 },
        new Date('2026-01-01T08:00:00Z'),
      ),
    ).toBe(false);
  });
  it('inside same-day window', () => {
    // 22:00–23:00 window, "now" = 22:30
    expect(
      inQuietHours(
        { ...base, quietStart: 22 * 60, quietEnd: 23 * 60 },
        new Date('2026-01-01T22:30:00Z'),
      ),
    ).toBe(true);
    expect(
      inQuietHours(
        { ...base, quietStart: 22 * 60, quietEnd: 23 * 60 },
        new Date('2026-01-01T21:59:00Z'),
      ),
    ).toBe(false);
    expect(
      inQuietHours(
        { ...base, quietStart: 22 * 60, quietEnd: 23 * 60 },
        new Date('2026-01-01T23:00:00Z'),
      ),
    ).toBe(false);
  });
  it('wrapping past midnight (22:00 → 06:00)', () => {
    const prefs = { ...base, quietStart: 22 * 60, quietEnd: 6 * 60 };
    // 23:00 → inside (after start)
    expect(inQuietHours(prefs, new Date('2026-01-01T23:00:00Z'))).toBe(true);
    // 03:00 → inside (before end)
    expect(inQuietHours(prefs, new Date('2026-01-01T03:00:00Z'))).toBe(true);
    // 09:00 → outside
    expect(inQuietHours(prefs, new Date('2026-01-01T09:00:00Z'))).toBe(false);
  });
});

describe('sendCaptureNotificationImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('happy path: sends to every subscription, updates last_used_at, returns sent count', async () => {
    await seedSubscription(db, userId, 'https://push.example/a');
    await seedSubscription(db, userId, 'https://push.example/b');
    const { transport, calls } = makeMockTransport();
    const env = makeTestEnv();

    const out = await sendCaptureNotificationImpl(
      env,
      db,
      userId,
      { id: 1, text: 'remember the milk' },
      { transport },
    );
    expect(out).toEqual({ skipped: null, sent: 2, failed: 0, deleted: 0 });
    expect(calls.map((c) => c.endpoint).sort()).toEqual([
      'https://push.example/a',
      'https://push.example/b',
    ]);
    expect(calls[0]?.title).toBe('New in inbox');
    expect(calls[0]?.body).toBe('remember the milk');
    expect(calls[0]?.tag).toBe('inbox-capture');

    const rows = (await db.execute(
      sql`SELECT COUNT(*)::int AS n FROM inbox.push_subscriptions WHERE last_used_at IS NOT NULL AND user_id = ${userId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect((list[0] as { n: number }).n).toBe(2);
  });

  it('truncates long bodies to 100 chars + ellipsis', async () => {
    await seedSubscription(db, userId, 'https://push.example/a');
    const { transport, calls } = makeMockTransport();
    const env = makeTestEnv();
    const long = 'x'.repeat(250);
    await sendCaptureNotificationImpl(env, db, userId, { id: 1, text: long }, { transport });
    expect(calls[0]?.body.length).toBe(100);
    expect(calls[0]?.body.endsWith('...')).toBe(true);
  });

  it('skips when on_capture is false', async () => {
    await seedSubscription(db, userId, 'https://push.example/a');
    await setPreferencesImpl(db, userId, { onCapture: false });
    const { transport, calls } = makeMockTransport();
    const env = makeTestEnv();
    const out = await sendCaptureNotificationImpl(env, db, userId, { id: 1, text: 'x' }, { transport });
    expect(out).toEqual({ skipped: 'opt-out', sent: 0, failed: 0, deleted: 0 });
    expect(calls).toHaveLength(0);
  });

  it('skips when current time is inside the quiet-hours window', async () => {
    await seedSubscription(db, userId, 'https://push.example/a');
    await setPreferencesImpl(db, userId, { quietStart: 22 * 60, quietEnd: 23 * 60 });
    const { transport, calls } = makeMockTransport();
    const env = makeTestEnv();
    const out = await sendCaptureNotificationImpl(
      env,
      db,
      userId,
      { id: 1, text: 'x' },
      { transport, now: new Date('2026-01-01T22:30:00Z') },
    );
    expect(out).toEqual({ skipped: 'quiet-hours', sent: 0, failed: 0, deleted: 0 });
    expect(calls).toHaveLength(0);
  });

  it('returns "no-subs" when the user has no subscriptions', async () => {
    const { transport, calls } = makeMockTransport();
    const env = makeTestEnv();
    const out = await sendCaptureNotificationImpl(env, db, userId, { id: 1, text: 'x' }, { transport });
    expect(out).toEqual({ skipped: 'no-subs', sent: 0, failed: 0, deleted: 0 });
    expect(calls).toHaveLength(0);
  });

  it('cleans up 410-gone endpoints immediately', async () => {
    await seedSubscription(db, userId, 'https://push.example/dead');
    await seedSubscription(db, userId, 'https://push.example/live');
    const { transport } = makeMockTransport({
      responder: (ep) =>
        ep.endsWith('/dead')
          ? { ok: false, gone: true, statusCode: 410 }
          : { ok: true },
    });
    const env = makeTestEnv();
    const out = await sendCaptureNotificationImpl(env, db, userId, { id: 1, text: 'x' }, { transport });
    expect(out.sent).toBe(1);
    expect(out.failed).toBe(1);
    expect(out.deleted).toBe(1);

    const rows = (await db.execute(
      sql`SELECT endpoint FROM inbox.push_subscriptions WHERE user_id = ${userId}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect(list.map((r) => (r as { endpoint: string }).endpoint)).toEqual([
      'https://push.example/live',
    ]);
  });

  it('bumps failed_count on non-gone failures, deletes after threshold', async () => {
    const id1 = await seedSubscription(db, userId, 'https://push.example/a', { failedCount: 0 });
    const id2 = await seedSubscription(db, userId, 'https://push.example/b', { failedCount: 4 });
    void id1;
    void id2;
    const { transport } = makeMockTransport({
      responder: () => ({ ok: false, gone: false, statusCode: 500 }),
    });
    const env = makeTestEnv();
    const out = await sendCaptureNotificationImpl(env, db, userId, { id: 1, text: 'x' }, { transport });
    expect(out.failed).toBe(2);
    // /b already had 4 failures, this is the 5th → deleted.  /a bumps to 1.
    expect(out.deleted).toBe(1);

    const rows = (await db.execute(
      sql`SELECT endpoint, failed_count FROM inbox.push_subscriptions WHERE user_id = ${userId} ORDER BY endpoint`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect(list).toHaveLength(1);
    const r0 = list[0] as { endpoint: string; failed_count: number };
    expect(r0.endpoint).toBe('https://push.example/a');
    expect(r0.failed_count).toBe(1);
  });

  it('swallows thrown transport errors and still bumps failure', async () => {
    await seedSubscription(db, userId, 'https://push.example/a', { failedCount: 4 });
    await seedSubscription(db, userId, 'https://push.example/b', { failedCount: 0 });
    const { transport } = makeMockTransport({ responder: () => 'throw' });
    const env = makeTestEnv();
    const out = await sendCaptureNotificationImpl(env, db, userId, { id: 1, text: 'x' }, { transport });
    expect(out.failed).toBe(2);
    expect(out.deleted).toBe(1); // /a hit threshold

    const rows = (await db.execute(
      sql`SELECT endpoint, failed_count FROM inbox.push_subscriptions WHERE user_id = ${userId} ORDER BY endpoint`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    expect(list).toHaveLength(1);
    const r0 = list[0] as { endpoint: string; failed_count: number };
    expect(r0.endpoint).toBe('https://push.example/b');
    expect(r0.failed_count).toBe(1);
  });

  it('uses PUBLIC_BASE_URL when set; falls back to inbox.allenlabs.org otherwise', async () => {
    await seedSubscription(db, userId, 'https://push.example/a');
    const env = makeTestEnv({ PUBLIC_BASE_URL: 'https://custom.test' });
    // Tap the transport call to inspect the rendered data.url.
    const seen: Array<Record<string, unknown>> = [];
    const transport: PushTransport = {
      async send(rendered) {
        seen.push({ ...(rendered.data ?? {}) });
        return {
          ok: true,
          data: { results: [{ endpoint: rendered.to.endpoint, ok: true, statusCode: 201 }] },
        };
      },
    };
    await sendCaptureNotificationImpl(env, db, userId, { id: 1, text: 'x' }, { transport });
    expect(seen[0]?.url).toBe('https://custom.test/');

    // And the fallback path (env.PUBLIC_BASE_URL absent):
    const env2 = { ...env };
    delete (env2 as { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL;
    seen.length = 0;
    await sendCaptureNotificationImpl(env2, db, userId, { id: 1, text: 'x' }, { transport });
    expect(seen[0]?.url).toBe('https://inbox.allenlabs.org/');
  });
});

describe('sendCaptureNotificationImpl — defensive', () => {
  // Cover the "transport returned ok:false envelope" branch (vs per-result
  // failure inside ok:true).  Distinct from the 'throw' case and the
  // per-subscription failed-result branch above.
  it('treats out.ok=false as a failure for that subscription', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'eve' });
    await seedSubscription(db, u.id, 'https://push.example/a', { failedCount: 4 });
    const transport: PushTransport = {
      async send() {
        return { ok: false, error: new Error('outer fail') };
      },
    };
    const env = makeTestEnv();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const out = await sendCaptureNotificationImpl(env, db, u.id, { id: 1, text: 't' }, { transport });
      expect(out.failed).toBe(1);
      expect(out.deleted).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
