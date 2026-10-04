import { describe, expect, it, beforeEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import {
  buildStateSummaryImpl,
  bumpLastNudgeImpl,
  composeNudgeImpl,
  dismissNudgeImpl,
  findApiClientImpl,
  gateNudge,
  getActiveNudgeImpl,
  getPreferencesImpl,
  inQuietHours,
  insertNudgeImpl,
  insertNudgeSchema,
  listEnabledUserIdsImpl,
  listNudgesImpl,
  markOpenedImpl,
  pickTopic,
  renderStateSummary,
  replyNudgeImpl,
  setPreferencesImpl,
  setPreferencesSchema,
  type StateSummary,
} from '~/server/concierge';

// ---------- quiet hours ----------

describe('inQuietHours', () => {
  it('returns false when either bound is null', () => {
    expect(inQuietHours({ quietStart: null, quietEnd: null })).toBe(false);
    expect(inQuietHours({ quietStart: 0, quietEnd: null })).toBe(false);
    expect(inQuietHours({ quietStart: null, quietEnd: 600 })).toBe(false);
  });
  it('returns false when start === end', () => {
    const at = new Date('2026-05-24T12:00:00Z');
    expect(inQuietHours({ quietStart: 600, quietEnd: 600 }, at)).toBe(false);
  });
  it('handles same-day windows', () => {
    const start = 22 * 60; // 22:00
    const end = 23 * 60;   // 23:00
    const inside = new Date('2026-05-24T22:30:00Z');
    const before = new Date('2026-05-24T21:00:00Z');
    expect(inQuietHours({ quietStart: start, quietEnd: end }, inside)).toBe(true);
    expect(inQuietHours({ quietStart: start, quietEnd: end }, before)).toBe(false);
  });
  it('wraps past midnight', () => {
    const start = 22 * 60; // 22:00
    const end = 6 * 60;    // 06:00 next day
    const lateNight = new Date('2026-05-24T23:30:00Z');
    const earlyMorning = new Date('2026-05-24T05:30:00Z');
    const noon = new Date('2026-05-24T12:00:00Z');
    expect(inQuietHours({ quietStart: start, quietEnd: end }, lateNight)).toBe(true);
    expect(inQuietHours({ quietStart: start, quietEnd: end }, earlyMorning)).toBe(true);
    expect(inQuietHours({ quietStart: start, quietEnd: end }, noon)).toBe(false);
  });
});

// ---------- cadence gate ----------

describe('gateNudge', () => {
  const baseline = {
    enabled: true,
    quietStart: null,
    quietEnd: null,
    cadenceMinutes: 240,
    lastNudgeAt: null,
  };
  it('blocks when disabled', () => {
    expect(gateNudge({ ...baseline, enabled: false })).toEqual({
      ok: false,
      reason: 'disabled',
    });
  });
  it('blocks during quiet hours', () => {
    const at = new Date('2026-05-24T22:30:00Z');
    const g = gateNudge({ ...baseline, quietStart: 22 * 60, quietEnd: 23 * 60 }, at);
    expect(g.ok).toBe(false);
    expect(g.reason).toBe('quiet-hours');
  });
  it('blocks when cadence has not elapsed', () => {
    const at = new Date('2026-05-24T12:00:00Z');
    // last nudge 30 minutes ago, cadence 240 min — must wait.
    const last = new Date(at.getTime() - 30 * 60_000).toISOString();
    const g = gateNudge({ ...baseline, lastNudgeAt: last }, at);
    expect(g.ok).toBe(false);
    expect(g.reason).toBe('cadence');
    expect(g.nextAt).toBeInstanceOf(Date);
  });
  it('allows when cadence has elapsed', () => {
    const at = new Date('2026-05-24T12:00:00Z');
    const last = new Date(at.getTime() - 300 * 60_000).toISOString();
    expect(gateNudge({ ...baseline, lastNudgeAt: last }, at).ok).toBe(true);
  });
  it('allows when no prior nudge', () => {
    expect(gateNudge(baseline).ok).toBe(true);
  });
  it('handles a malformed lastNudgeAt as "no prior"', () => {
    expect(
      gateNudge({ ...baseline, lastNudgeAt: 'not-a-date' as unknown as string }).ok,
    ).toBe(true);
  });
});

// ---------- state summary ----------

async function seedState(
  db: TestDB,
  userId: number,
  opts: {
    inboxUnreadTexts?: string[];
    inboxCapturedAt?: Date;
    activeFocus?: boolean;
    lastFocusEndedAt?: Date;
    lastFocusReason?: 'completed' | 'abandoned';
    lastFocusTask?: string;
    pmOpen?: number;
    pmLastClosedAt?: Date;
    pmLastClosedTitle?: string;
    ctxLastAt?: Date;
    ctxLastName?: string;
  } = {},
): Promise<void> {
  const capAt = opts.inboxCapturedAt ?? new Date('2026-05-24T10:00:00Z');
  const texts = opts.inboxUnreadTexts ?? [];
  for (let i = 0; i < texts.length; i++) {
    // Stagger each row by a minute so "ORDER BY captured_at DESC LIMIT 1"
    // breaks ties predictably (later in the array = more recent).
    const stamp = new Date(capAt.getTime() + i * 60_000).toISOString();
    await db.execute(
      sql`INSERT INTO inbox.items (user_id, text, status, captured_at)
          VALUES (${userId}, ${texts[i]}, 'unread', ${stamp}::timestamptz)`,
    );
  }
  if (opts.activeFocus) {
    await db.execute(
      sql`INSERT INTO focus.sessions (user_id, task_text, started_at) VALUES
          (${userId}, 'live work', NOW())`,
    );
  }
  if (opts.lastFocusEndedAt && opts.lastFocusTask) {
    await db.execute(
      sql`INSERT INTO focus.sessions (user_id, task_text, started_at, ended_at, ended_reason)
          VALUES (${userId}, ${opts.lastFocusTask},
                  ${opts.lastFocusEndedAt.toISOString()}::timestamptz - INTERVAL '20 minutes',
                  ${opts.lastFocusEndedAt.toISOString()}::timestamptz,
                  ${opts.lastFocusReason ?? 'completed'})`,
    );
  }
  for (let i = 0; i < (opts.pmOpen ?? 0); i++) {
    // status_id=1 is the seeded "New" (is_closed=false) row.
    await db.execute(
      sql`INSERT INTO pm.issues (subject, assigned_to_id, status_id)
          VALUES (${'open-' + i}, ${userId}, 1)`,
    );
  }
  if (opts.pmLastClosedAt && opts.pmLastClosedTitle) {
    // status_id=5 is the seeded "Closed" (is_closed=true) row.
    await db.execute(
      sql`INSERT INTO pm.issues (subject, assigned_to_id, status_id, closed_at)
          VALUES (${opts.pmLastClosedTitle}, ${userId}, 5,
                  ${opts.pmLastClosedAt.toISOString()}::timestamptz)`,
    );
  }
  if (opts.ctxLastAt && opts.ctxLastName) {
    await db.execute(
      sql`INSERT INTO context.snapshots (user_id, name, created_at)
          VALUES (${userId}, ${opts.ctxLastName}, ${opts.ctxLastAt.toISOString()}::timestamptz)`,
    );
  }
}

describe('buildStateSummaryImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  it('returns zeros / nulls when no state', async () => {
    const s = await buildStateSummaryImpl(db, userId);
    expect(s).toEqual({
      inboxUnread: 0,
      inboxLastCapturedAt: null,
      inboxLastText: null,
      focusActive: false,
      focusLastEndedAt: null,
      focusLastEndedReason: null,
      focusLastTaskText: null,
      pmOpenIssues: 0,
      pmLastClosedAt: null,
      pmLastClosedTitle: null,
      contextLastSavedAt: null,
      contextLastName: null,
      recentNudges: [],
    });
  });

  it('populates inbox stats', async () => {
    await seedState(db, userId, {
      inboxUnreadTexts: ['old', 'newer'],
      inboxCapturedAt: new Date('2026-05-23T08:00:00Z'),
    });
    const s = await buildStateSummaryImpl(db, userId);
    expect(s.inboxUnread).toBe(2);
    expect(s.inboxLastText).toBe('newer');
    expect(s.inboxLastCapturedAt).not.toBeNull();
  });

  it('flags an active focus session', async () => {
    await seedState(db, userId, { activeFocus: true });
    const s = await buildStateSummaryImpl(db, userId);
    expect(s.focusActive).toBe(true);
  });

  it('captures the last ended focus session', async () => {
    await seedState(db, userId, {
      lastFocusEndedAt: new Date('2026-05-24T09:00:00Z'),
      lastFocusReason: 'abandoned',
      lastFocusTask: 'fix /search 500s',
    });
    const s = await buildStateSummaryImpl(db, userId);
    expect(s.focusLastTaskText).toBe('fix /search 500s');
    expect(s.focusLastEndedReason).toBe('abandoned');
  });

  it('counts pm open issues + surfaces last closed', async () => {
    await seedState(db, userId, {
      pmOpen: 2,
      pmLastClosedAt: new Date('2026-05-24T08:00:00Z'),
      pmLastClosedTitle: 'fix /search 500s',
    });
    const s = await buildStateSummaryImpl(db, userId);
    expect(s.pmOpenIssues).toBe(2);
    expect(s.pmLastClosedTitle).toBe('fix /search 500s');
  });

  it('surfaces the last context snapshot', async () => {
    await seedState(db, userId, {
      ctxLastAt: new Date('2026-05-24T07:00:00Z'),
      ctxLastName: 'fixing auth bug',
    });
    const s = await buildStateSummaryImpl(db, userId);
    expect(s.contextLastName).toBe('fixing auth bug');
  });

  it('includes the last 3 nudges so the LLM can avoid repeating', async () => {
    for (let i = 0; i < 5; i++) {
      await insertNudgeImpl(
        db,
        {
          userId,
          topic: 'open-thread',
          question: `q${i}`,
          channels: ['today'],
        },
        new Date(2026, 0, 1, i),
      );
    }
    const s = await buildStateSummaryImpl(db, userId);
    expect(s.recentNudges.length).toBe(3);
    // newest first
    expect(s.recentNudges[0]!.question).toBe('q4');
  });

  it('does not leak across users', async () => {
    const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
    await seedState(db, other.id, { inboxUnreadTexts: ['secret'] });
    const s = await buildStateSummaryImpl(db, userId);
    expect(s.inboxUnread).toBe(0);
  });
});

// ---------- renderStateSummary ----------

describe('renderStateSummary', () => {
  const NOW = new Date('2026-05-24T12:00:00Z');
  const empty: StateSummary = {
    inboxUnread: 0,
    inboxLastCapturedAt: null,
    inboxLastText: null,
    focusActive: false,
    focusLastEndedAt: null,
    focusLastEndedReason: null,
    focusLastTaskText: null,
    pmOpenIssues: 0,
    pmLastClosedAt: null,
    pmLastClosedTitle: null,
    contextLastSavedAt: null,
    contextLastName: null,
    recentNudges: [],
  };

  it('renders the empty-state baseline', () => {
    const out = renderStateSummary(empty, NOW);
    expect(out).toContain('Inbox: 0 unread.');
    expect(out).toContain('Focus: no active session.');
    expect(out).toContain('PM: 0 open');
    expect(out).toContain('Context: no snapshots');
  });

  it('includes a truncated inbox preview', () => {
    const long = 'x'.repeat(120);
    const out = renderStateSummary(
      {
        ...empty,
        inboxUnread: 1,
        inboxLastCapturedAt: new Date(NOW.getTime() - 5 * 60_000).toISOString(),
        inboxLastText: long,
      },
      NOW,
    );
    expect(out).toMatch(/Last captured 5m ago/);
    expect(out).toMatch(/x{77}\.\.\./);
  });

  it('renders an active focus session', () => {
    const out = renderStateSummary({ ...empty, focusActive: true }, NOW);
    expect(out).toContain('active session right now');
  });

  it('renders the last focus session with reason', () => {
    const out = renderStateSummary(
      {
        ...empty,
        focusLastEndedAt: new Date(NOW.getTime() - 12 * 60_000).toISOString(),
        focusLastEndedReason: 'abandoned',
        focusLastTaskText: 'design review',
      },
      NOW,
    );
    expect(out).toMatch(/Last session "design review" abandoned 12m ago/);
  });

  it('defaults the focus reason when null', () => {
    const out = renderStateSummary(
      {
        ...empty,
        focusLastEndedAt: new Date(NOW.getTime() - 12 * 60_000).toISOString(),
        focusLastEndedReason: null,
        focusLastTaskText: 'design review',
      },
      NOW,
    );
    expect(out).toMatch(/ended 12m ago/);
  });

  it('renders pm last-closed when present', () => {
    const out = renderStateSummary(
      {
        ...empty,
        pmOpenIssues: 3,
        pmLastClosedAt: new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
        pmLastClosedTitle: 'fix /search',
      },
      NOW,
    );
    expect(out).toMatch(/PM: 3 open/);
    expect(out).toMatch(/Last closed 2h ago: "fix \/search"/);
  });

  it('renders the context snapshot when present', () => {
    const out = renderStateSummary(
      {
        ...empty,
        contextLastSavedAt: new Date(NOW.getTime() - 25 * 3600_000).toISOString(),
        contextLastName: 'fixing auth',
      },
      NOW,
    );
    expect(out).toMatch(/Context: last snapshot "fixing auth" 1d ago/);
  });

  it('rolls "just now" / "Xm ago" / "Xh ago" / "Nd ago" boundaries', () => {
    const now = NOW.getTime();
    const out = renderStateSummary(
      {
        ...empty,
        inboxUnread: 4,
        inboxLastText: 'one',
        inboxLastCapturedAt: new Date(now - 30_000).toISOString(),
      },
      NOW,
    );
    expect(out).toMatch(/just now/);
  });

  it('renders recent nudges so the LLM avoids repeats', () => {
    const out = renderStateSummary(
      {
        ...empty,
        recentNudges: [
          { topic: 'inbox-idle', question: 'old q', sentAt: new Date(NOW.getTime() - 60_000).toISOString() },
        ],
      },
      NOW,
    );
    expect(out).toMatch(/Recent nudges/);
    expect(out).toMatch(/\[inbox-idle, 1m ago\] old q/);
  });
});

// ---------- LLM client ----------

describe('composeNudgeImpl', () => {
  const env = {
    LLM_BASE_URL: 'https://llm.test/v1',
    LLM_API_KEY: 'abc',
    LLM_MODEL: 'gpt-4o-mini',
  };

  function makeFetch(
    handler: (req: Request) => Promise<Response> | Response,
  ): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as string, init);
      return await handler(req);
    }) as typeof fetch;
  }

  it('POSTs to the chat/completions endpoint with the right shape', async () => {
    let seen: { url?: string; body?: unknown; authz?: string } = {};
    const fetchFn = makeFetch(async (req) => {
      seen.url = req.url;
      seen.authz = req.headers.get('authorization') ?? undefined;
      seen.body = (await req.json()) as unknown;
      return new Response(
        JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'You closed X — try Y next?' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const r = await composeNudgeImpl(env, { stateSummary: 'state' }, fetchFn);
    expect(seen.url).toBe('https://llm.test/v1/chat/completions');
    expect(seen.authz).toBe('Bearer abc');
    const body = seen.body as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.temperature).toBe(0.5);
    expect(body.messages[0]!.role).toBe('system');
    expect(body.messages[1]!.role).toBe('user');
    expect(body.messages[1]!.content).toContain('state');
    expect(r.question).toBe('You closed X — try Y next?');
    expect(r.model).toBe('gpt-4o-mini');
  });

  it('returns null for "SKIP"', async () => {
    const fetchFn = makeFetch(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'SKIP' } }] }),
        { status: 200 },
      ));
    const r = await composeNudgeImpl(env, { stateSummary: 'x' }, fetchFn);
    expect(r.question).toBeNull();
  });

  it('returns null for a leading "SKIP" (with trailing whitespace)', async () => {
    const fetchFn = makeFetch(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'SKIP — nothing notable.' } }] }),
        { status: 200 },
      ));
    const r = await composeNudgeImpl(env, { stateSummary: 'x' }, fetchFn);
    expect(r.question).toBeNull();
  });

  it('returns null on an empty completion', async () => {
    const fetchFn = makeFetch(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '' } }] }),
        { status: 200 },
      ));
    const r = await composeNudgeImpl(env, { stateSummary: 'x' }, fetchFn);
    expect(r.question).toBeNull();
  });

  it('strips a leading "Question:" prefix', async () => {
    const fetchFn = makeFetch(() =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'Question: try Y next?' } }] }),
        { status: 200 },
      ));
    const r = await composeNudgeImpl(env, { stateSummary: 'x' }, fetchFn);
    expect(r.question).toBe('try Y next?');
  });

  it('throws on HTTP error', async () => {
    const fetchFn = makeFetch(() => new Response('rate limit', { status: 429 }));
    await expect(
      composeNudgeImpl(env, { stateSummary: 'x' }, fetchFn),
    ).rejects.toThrow(/LLM 429/);
  });

  it('uses the default model when LLM_MODEL is unset', async () => {
    let seenModel: string | undefined;
    const fetchFn = makeFetch(async (req) => {
      const body = (await req.json()) as { model: string };
      seenModel = body.model;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'ok' } }] }),
        { status: 200 },
      );
    });
    const r = await composeNudgeImpl(
      { LLM_BASE_URL: env.LLM_BASE_URL, LLM_API_KEY: env.LLM_API_KEY },
      { stateSummary: 'x' },
      fetchFn,
    );
    expect(seenModel).toBe('gpt-4o-mini');
    expect(r.model).toBe('gpt-4o-mini');
  });

  it('returns the server-reported model when present', async () => {
    const fetchFn = makeFetch(() =>
      new Response(
        JSON.stringify({
          model: 'gpt-4o-mini-2024-07-18',
          choices: [{ message: { content: 'q' } }],
        }),
        { status: 200 },
      ));
    const r = await composeNudgeImpl(env, { stateSummary: 'x' }, fetchFn);
    expect(r.model).toBe('gpt-4o-mini-2024-07-18');
  });

  it('prepends a trigger when provided', async () => {
    let seenUserMessage: string | undefined;
    const fetchFn = makeFetch(async (req) => {
      const body = (await req.json()) as {
        messages: Array<{ role: string; content: string }>;
      };
      seenUserMessage = body.messages[1]!.content;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'q' } }] }),
        { status: 200 },
      );
    });
    await composeNudgeImpl(
      env,
      { stateSummary: 'state', trigger: 'TRIGGER!' },
      fetchFn,
    );
    expect(seenUserMessage).toMatch(/^TRIGGER!/);
    expect(seenUserMessage).toContain('state');
  });

  it('strips a trailing slash on LLM_BASE_URL', async () => {
    let seenUrl: string | undefined;
    const fetchFn = makeFetch(async (req) => {
      seenUrl = req.url;
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'q' } }] }),
        { status: 200 },
      );
    });
    await composeNudgeImpl(
      { LLM_BASE_URL: 'https://llm.test/v1/', LLM_API_KEY: 'k' },
      { stateSummary: 'x' },
      fetchFn,
    );
    expect(seenUrl).toBe('https://llm.test/v1/chat/completions');
  });

  it('handles a missing message body via SKIP path', async () => {
    const fetchFn = makeFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const r = await composeNudgeImpl(env, { stateSummary: 'x' }, fetchFn);
    expect(r.question).toBeNull();
  });
});

// ---------- pickTopic ----------

describe('pickTopic', () => {
  const empty: StateSummary = {
    inboxUnread: 0,
    inboxLastCapturedAt: null,
    inboxLastText: null,
    focusActive: false,
    focusLastEndedAt: null,
    focusLastEndedReason: null,
    focusLastTaskText: null,
    pmOpenIssues: 0,
    pmLastClosedAt: null,
    pmLastClosedTitle: null,
    contextLastSavedAt: null,
    contextLastName: null,
    recentNudges: [],
  };
  const NOW = new Date('2026-05-24T12:00:00Z');

  it('returns "focus-abandoned" when the last session was abandoned', () => {
    expect(pickTopic({ ...empty, focusLastEndedReason: 'abandoned' }, NOW)).toBe(
      'focus-abandoned',
    );
  });

  it('returns "celebration" right after a recent PM close + open inbox', () => {
    expect(
      pickTopic(
        {
          ...empty,
          pmLastClosedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
          inboxUnread: 2,
        },
        NOW,
      ),
    ).toBe('celebration');
  });

  it('returns "inbox-idle" when the last unread is > 24h old', () => {
    expect(
      pickTopic(
        {
          ...empty,
          inboxUnread: 1,
          inboxLastCapturedAt: new Date(NOW.getTime() - 30 * 3600_000).toISOString(),
        },
        NOW,
      ),
    ).toBe('inbox-idle');
  });

  it('returns "pm-stalled" when open issues > 0 and nothing else', () => {
    expect(pickTopic({ ...empty, pmOpenIssues: 3 }, NOW)).toBe('pm-stalled');
  });

  it('returns "open-thread" as a catch-all', () => {
    expect(pickTopic(empty, NOW)).toBe('open-thread');
  });
});

// ---------- nudges + preferences DB ----------

describe('insertNudgeImpl + insertNudgeSchema', () => {
  it('rejects invalid input shapes', () => {
    expect(insertNudgeSchema.safeParse({}).success).toBe(false);
    expect(
      insertNudgeSchema.safeParse({
        userId: 1,
        topic: 'bogus',
        question: 'x',
      }).success,
    ).toBe(false);
  });

  it('inserts and returns the row with parsed channels', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const row = await insertNudgeImpl(db, {
      userId: u.id,
      topic: 'inbox-idle',
      question: 'q',
      contextSummary: 'ctx',
      model: 'gpt-4o-mini',
      channels: ['push', 'today'],
    });
    expect(row.topic).toBe('inbox-idle');
    expect(row.channels).toEqual(['push', 'today']);
    expect(row.sentAt).toMatch(/Z$/);
  });
});

describe('listNudgesImpl', () => {
  it('returns rows in DESC order, scoped to the user, capped at the limit', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const other = await insertPmUser(db, { login: 'm', sub: 'sso-m' });
    await insertNudgeImpl(
      db,
      { userId: u.id, topic: 'open-thread', question: 'a', channels: [] },
      new Date(2026, 0, 1),
    );
    await insertNudgeImpl(
      db,
      { userId: u.id, topic: 'open-thread', question: 'b', channels: [] },
      new Date(2026, 0, 2),
    );
    await insertNudgeImpl(
      db,
      { userId: other.id, topic: 'open-thread', question: 'no leak', channels: [] },
      new Date(2026, 0, 3),
    );
    const rows = await listNudgesImpl(db, u.id);
    expect(rows.map((r) => r.question)).toEqual(['b', 'a']);
    // capped
    expect((await listNudgesImpl(db, u.id, 1)).length).toBe(1);
    // pathological inputs clamp
    expect(Array.isArray(await listNudgesImpl(db, u.id, 0))).toBe(true);
    expect(Array.isArray(await listNudgesImpl(db, u.id, 9999))).toBe(true);
  });
});

describe('getActiveNudgeImpl', () => {
  it('returns the most recent unopened nudge, ignoring dismissed/replied', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const a = await insertNudgeImpl(
      db,
      { userId: u.id, topic: 'open-thread', question: 'a', channels: [] },
      new Date(2026, 0, 1),
    );
    const b = await insertNudgeImpl(
      db,
      { userId: u.id, topic: 'open-thread', question: 'b', channels: [] },
      new Date(2026, 0, 2),
    );
    // Dismiss the newest — the older one should now surface.
    await dismissNudgeImpl(db, u.id, b.id);
    const active = await getActiveNudgeImpl(db, u.id);
    expect(active?.id).toBe(a.id);
    // Reply to the remaining one — none should surface.
    await replyNudgeImpl(db, u.id, a.id, 'noted');
    expect(await getActiveNudgeImpl(db, u.id)).toBeNull();
  });

  it('returns null when the user has no nudges', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    expect(await getActiveNudgeImpl(db, u.id)).toBeNull();
  });
});

describe('markOpenedImpl / dismissNudgeImpl / replyNudgeImpl', () => {
  it('marks open / dismiss / reply only for the owning user', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'alice' });
    const m = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
    const n = await insertNudgeImpl(db, {
      userId: a.id,
      topic: 'open-thread',
      question: 'q',
      channels: [],
    });
    expect(await markOpenedImpl(db, a.id, n.id)).toBe(true);
    // second open is idempotent
    expect(await markOpenedImpl(db, a.id, n.id)).toBe(true);
    expect(await markOpenedImpl(db, m.id, n.id)).toBe(false);
    expect(await dismissNudgeImpl(db, m.id, n.id)).toBe(false);
    expect(await replyNudgeImpl(db, m.id, n.id, 'x')).toBe(false);
    expect(await replyNudgeImpl(db, a.id, n.id, 'noted')).toBe(true);
  });

  it('returns false for a missing id', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'alice' });
    expect(await markOpenedImpl(db, a.id, 99_999)).toBe(false);
    expect(await dismissNudgeImpl(db, a.id, 99_999)).toBe(false);
    expect(await replyNudgeImpl(db, a.id, 99_999, 'x')).toBe(false);
  });
});

describe('preferences', () => {
  it('returns defaults when no row exists', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const p = await getPreferencesImpl(db, u.id);
    expect(p.userId).toBe(u.id);
    expect(p.enabled).toBe(true);
    expect(p.cadenceMinutes).toBe(240);
    expect(p.quietStart).toBeNull();
    expect(p.quietEnd).toBeNull();
  });

  it('upserts via setPreferencesImpl and round-trips', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await setPreferencesImpl(db, u.id, {
      enabled: false,
      cadenceMinutes: 60,
      quietStart: 22 * 60,
      quietEnd: 6 * 60,
    });
    const p = await getPreferencesImpl(db, u.id);
    expect(p.enabled).toBe(false);
    expect(p.cadenceMinutes).toBe(60);
    expect(p.quietStart).toBe(22 * 60);
    expect(p.quietEnd).toBe(6 * 60);

    // partial update preserves untouched fields
    await setPreferencesImpl(db, u.id, { enabled: true });
    const p2 = await getPreferencesImpl(db, u.id);
    expect(p2.enabled).toBe(true);
    expect(p2.cadenceMinutes).toBe(60);
    expect(p2.quietStart).toBe(22 * 60);
  });

  it('lets quietStart/quietEnd be cleared with null', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await setPreferencesImpl(db, u.id, { quietStart: 600, quietEnd: 700 });
    await setPreferencesImpl(db, u.id, { quietStart: null, quietEnd: null });
    const p = await getPreferencesImpl(db, u.id);
    expect(p.quietStart).toBeNull();
    expect(p.quietEnd).toBeNull();
  });

  it('rejects out-of-range cadence + quiet bounds', () => {
    expect(
      setPreferencesSchema.safeParse({ cadenceMinutes: 0 }).success,
    ).toBe(false);
    expect(
      setPreferencesSchema.safeParse({ cadenceMinutes: 99999 }).success,
    ).toBe(false);
    expect(setPreferencesSchema.safeParse({ quietStart: -1 }).success).toBe(false);
    expect(setPreferencesSchema.safeParse({ quietStart: 1440 }).success).toBe(false);
  });

  it('bumpLastNudgeImpl creates a row and stamps last_nudge_at', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    const t = new Date('2026-05-24T12:00:00Z');
    await bumpLastNudgeImpl(db, u.id, t);
    const p = await getPreferencesImpl(db, u.id);
    expect(p.lastNudgeAt).toBe(t.toISOString());
  });

  it('bumpLastNudgeImpl updates an existing row in place', async () => {
    const db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    await setPreferencesImpl(db, u.id, { cadenceMinutes: 60 });
    const t = new Date('2026-05-24T12:00:00Z');
    await bumpLastNudgeImpl(db, u.id, t);
    const p = await getPreferencesImpl(db, u.id);
    expect(p.lastNudgeAt).toBe(t.toISOString());
    expect(p.cadenceMinutes).toBe(60);
  });
});

describe('listEnabledUserIdsImpl', () => {
  it('returns user_ids with enabled=true, capped at the limit', async () => {
    const db = await makeTestDb();
    const a = await insertPmUser(db, { login: 'a' });
    const b = await insertPmUser(db, { login: 'b', sub: 'sso-b' });
    const c = await insertPmUser(db, { login: 'c', sub: 'sso-c' });
    await setPreferencesImpl(db, a.id, { enabled: true });
    await setPreferencesImpl(db, b.id, { enabled: false });
    await setPreferencesImpl(db, c.id, { enabled: true });
    const ids = await listEnabledUserIdsImpl(db);
    expect(ids).toEqual([a.id, c.id].sort((x, y) => x - y));
    expect((await listEnabledUserIdsImpl(db, 1)).length).toBe(1);
    // pathological inputs clamp
    expect(Array.isArray(await listEnabledUserIdsImpl(db, 0))).toBe(true);
  });
});

describe('findApiClientImpl', () => {
  it('finds the seeded cli row by client_id', async () => {
    const db = await makeTestDb();
    const found = await findApiClientImpl(db, 'cli');
    expect(found?.clientId).toBe('cli');
    expect(found?.userId).toBe(1);
  });

  it('returns null for unknown client_id', async () => {
    const db = await makeTestDb();
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});
