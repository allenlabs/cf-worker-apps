import { describe, expect, it, beforeEach } from 'vitest';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import { processNudgeForUserImpl } from '~/server/pipeline';
import { setPreferencesImpl, listNudgesImpl, getPreferencesImpl } from '~/server/concierge';

function makeFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return await handler(req);
  }) as typeof fetch;
}

function llmResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { content: text } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('processNudgeForUserImpl', () => {
  let db: TestDB;
  let userId: number;
  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
  });

  const env = {
    LLM_BASE_URL: 'https://llm.test/v1',
    LLM_API_KEY: 'k',
  };

  it('inserts a nudge and bumps last_nudge_at on success', async () => {
    const fetchFn = makeFetch((req) => {
      if (req.url.includes('/chat/completions')) return llmResponse('Try Y next?');
      throw new Error(`unexpected fetch: ${req.url}`);
    });
    const r = await processNudgeForUserImpl(env, db, userId, {
      now: new Date('2026-05-24T12:00:00Z'),
      fetchFn,
      channels: ['today'],
    });
    expect(r.status).toBe('sent');
    expect(r.nudge?.question).toBe('Try Y next?');
    expect(r.nudge?.channels).toEqual(['today']);
    const rows = await listNudgesImpl(db, userId);
    expect(rows.length).toBe(1);
    const prefs = await getPreferencesImpl(db, userId);
    expect(prefs.lastNudgeAt).not.toBeNull();
  });

  it('skips with reason=disabled when preferences are off', async () => {
    await setPreferencesImpl(db, userId, { enabled: false });
    const fetchFn = makeFetch(() => llmResponse('Q'));
    const r = await processNudgeForUserImpl(env, db, userId, { fetchFn });
    expect(r.status).toBe('skipped-gate');
    expect(r.reason).toBe('disabled');
    expect((await listNudgesImpl(db, userId)).length).toBe(0);
  });

  it('skips with reason=cadence when last_nudge_at is recent', async () => {
    const t0 = new Date('2026-05-24T12:00:00Z');
    await setPreferencesImpl(db, userId, { cadenceMinutes: 240 });
    // Stamp last_nudge_at to a recent time by directly calling the pipeline once.
    const fetchFn = makeFetch(() => llmResponse('Q'));
    await processNudgeForUserImpl(env, db, userId, { now: t0, fetchFn });
    // Now try again 1 minute later — cadence should block.
    const r = await processNudgeForUserImpl(env, db, userId, {
      now: new Date(t0.getTime() + 60_000),
      fetchFn,
    });
    expect(r.status).toBe('skipped-gate');
    expect(r.reason).toBe('cadence');
  });

  it('skips with reason=no-question when the LLM says SKIP', async () => {
    const fetchFn = makeFetch(() => llmResponse('SKIP'));
    const r = await processNudgeForUserImpl(env, db, userId, { fetchFn });
    expect(r.status).toBe('skipped-llm');
    expect(r.reason).toBe('no-question');
    expect((await listNudgesImpl(db, userId)).length).toBe(0);
  });

  it('attempts push when channels include "push" and reports pushed=true on 2xx', async () => {
    const fetchFn = makeFetch((req) => {
      if (req.url.includes('/chat/completions')) return llmResponse('q');
      if (req.url.includes('/v1/notify')) return new Response('', { status: 200 });
      throw new Error(`unexpected: ${req.url}`);
    });
    const r = await processNudgeForUserImpl(
      {
        ...env,
        INBOX_API_URL: 'https://inbox-api.test',
        INBOX_HMAC_CLIENT_ID: 'concierge',
        INBOX_HMAC_SECRET: 's',
      },
      db,
      userId,
      { fetchFn, channels: ['push', 'today'] },
    );
    expect(r.status).toBe('sent');
    expect(r.pushed).toBe(true);
  });

  it('records the topic as "event" when trigger is set', async () => {
    const fetchFn = makeFetch(() => llmResponse('q'));
    const r = await processNudgeForUserImpl(env, db, userId, {
      trigger: 'Cross-app event: capture',
      fetchFn,
      channels: ['today'],
    });
    expect(r.status).toBe('sent');
    expect(r.nudge?.topic).toBe('event');
  });

  it('uses the heuristic topic-picker when no trigger is provided', async () => {
    // Seed PM open issues so pickTopic lands on 'pm-stalled'.
    const { sql } = await import('drizzle-orm');
    await db.execute(
      sql`INSERT INTO pm.issues (subject, assigned_to_id, status_id) VALUES ('open', ${userId}, 1)`,
    );
    const fetchFn = makeFetch(() => llmResponse('q'));
    const r = await processNudgeForUserImpl(env, db, userId, {
      fetchFn,
      channels: ['today'],
    });
    expect(r.status).toBe('sent');
    expect(r.nudge?.topic).toBe('pm-stalled');
  });
});
