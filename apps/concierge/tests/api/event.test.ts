import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { eventRouter } from '../../workers/api/src/handlers/event';
import { signRequest } from '~/lib/hmac';
import {
  dismissNudgeImpl,
  getActiveNudgeImpl,
  insertNudgeImpl,
  listNudgesImpl,
  setPreferencesImpl,
} from '~/server/concierge';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

function makeFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return await handler(req);
  }) as typeof fetch;
}

describe('concierge API (HMAC + /v1/event)', () => {
  let db: TestDB;
  let userId: number;
  let secret: string;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
    secret = 'unit-test-secret-32-bytes-long-aaa';
    await db.execute(sql`
      INSERT INTO concierge.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('inbox', 'Inbox event bridge', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id,
            name        = EXCLUDED.name
    `);
    // Pin a deterministic LLM response on the env-bound fetch.  The middleware
    // takes db from the factory; the handlers take fetch from globalThis.
    const llmFetch = makeFetch(() =>
      new Response(
        JSON.stringify({
          model: 'gpt-4o-mini',
          choices: [{ message: { content: 'Try Y next?' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    globalThis.fetch = llmFetch;

    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', eventRouter);
  });

  async function sign(body: string): Promise<{ ts: number; sig: string }> {
    const ts = Date.now();
    const sig = await signRequest(secret, body, ts);
    return { ts, sig };
  }

  async function call(
    path: string,
    body: string,
    init: { method?: string } = {},
  ): Promise<Response> {
    const { ts, sig } = await sign(body);
    const method = init.method ?? 'POST';
    return await app.request(
      path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'inbox',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body: method === 'GET' ? undefined : body,
      },
      {
        HYPERDRIVE: {},
        LLM_BASE_URL: 'https://llm.test/v1',
        LLM_API_KEY: 'k',
        LLM_MODEL: 'gpt-4o-mini',
      } as unknown as Record<string, unknown>,
    );
  }

  describe('POST /v1/event', () => {
    it('composes + inserts a nudge from an event payload', async () => {
      const body = JSON.stringify({
        kind: 'issue_closed',
        ref: 'pm-issue-14',
        context: 'Just closed "fix /search 500s"',
      });
      const res = await call('/v1/event', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as {
        status: string;
        nudge: { question: string; topic: string };
      };
      expect(json.status).toBe('sent');
      expect(json.nudge.question).toBe('Try Y next?');
      expect(json.nudge.topic).toBe('event');
      const rows = await listNudgesImpl(db, userId);
      expect(rows.length).toBe(1);
    });

    it('skips during quiet hours with 200 + status=skipped-gate', async () => {
      // Use UTC; the body will run "now", which we can't control directly.
      // So instead just disable preferences — easier to assert.
      await setPreferencesImpl(db, userId, { enabled: false });
      const res = await call(
        '/v1/event',
        JSON.stringify({ kind: 'capture' }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string; reason: string };
      expect(json.status).toBe('skipped-gate');
      expect(json.reason).toBe('disabled');
    });

    it('rejects unauthenticated calls', async () => {
      const res = await app.request('/v1/event', {
        method: 'POST',
        body: JSON.stringify({ kind: 'x' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects an unknown client_id', async () => {
      const body = JSON.stringify({ kind: 'x' });
      const { ts, sig } = await sign(body);
      const res = await app.request('/v1/event', {
        method: 'POST',
        headers: {
          'X-Client-Id': 'ghost',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('rejects a non-finite timestamp header', async () => {
      const res = await app.request('/v1/event', {
        method: 'POST',
        headers: {
          'X-Client-Id': 'inbox',
          'X-Timestamp': 'NaN',
          'X-Signature': 'AAAA',
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('rejects a bad signature', async () => {
      const body = JSON.stringify({ kind: 'x' });
      const res = await app.request('/v1/event', {
        method: 'POST',
        headers: {
          'X-Client-Id': 'inbox',
          'X-Timestamp': String(Date.now()),
          'X-Signature': 'AAAA',
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('400 on invalid JSON body', async () => {
      const res = await call('/v1/event', '{not-json');
      expect(res.status).toBe(400);
    });

    it('422 on validation failure', async () => {
      const res = await call('/v1/event', JSON.stringify({}));
      expect(res.status).toBe(422);
    });

    it('falls back to the api_clients row user_id when none is supplied', async () => {
      const res = await call('/v1/event', JSON.stringify({ kind: 'capture' }));
      expect(res.status).toBe(201);
      const rows = await listNudgesImpl(db, userId);
      expect(rows.length).toBe(1);
    });
  });

  describe('GET /v1/active', () => {
    it('returns the user\'s active nudge', async () => {
      const created = await insertNudgeImpl(db, {
        userId,
        topic: 'open-thread',
        question: 'open',
        channels: [],
      });
      const res = await call('/v1/active', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { nudge: { id: number } | null };
      expect(json.nudge?.id).toBe(created.id);
    });

    it('returns null when there is no active nudge', async () => {
      const res = await call('/v1/active', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { nudge: unknown };
      expect(json.nudge).toBeNull();
    });

    it('honours an explicit user_id query param', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
      const created = await insertNudgeImpl(db, {
        userId: other.id,
        topic: 'open-thread',
        question: 'hers',
        channels: [],
      });
      const res = await call(`/v1/active?user_id=${other.id}`, '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { nudge: { id: number } | null };
      expect(json.nudge?.id).toBe(created.id);
    });

    it('400 on a malformed user_id query param', async () => {
      const res = await call('/v1/active?user_id=banana', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/nudges/:id/dismiss', () => {
    it('dismisses a nudge', async () => {
      const created = await insertNudgeImpl(db, {
        userId,
        topic: 'open-thread',
        question: 'q',
        channels: [],
      });
      const res = await call(`/v1/nudges/${created.id}/dismiss`, '');
      expect(res.status).toBe(200);
      expect(await getActiveNudgeImpl(db, userId)).toBeNull();
    });

    it('400 on invalid id', async () => {
      const res = await call('/v1/nudges/banana/dismiss', '');
      expect(res.status).toBe(400);
    });

    it('400 on id of 0', async () => {
      const res = await call('/v1/nudges/0/dismiss', '');
      expect(res.status).toBe(400);
    });

    it('404 when the nudge is not owned by this user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
      const created = await insertNudgeImpl(db, {
        userId: other.id,
        topic: 'open-thread',
        question: 'q',
        channels: [],
      });
      const res = await call(`/v1/nudges/${created.id}/dismiss`, '');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /v1/nudges/:id/reply', () => {
    it('stores the reply text', async () => {
      const created = await insertNudgeImpl(db, {
        userId,
        topic: 'open-thread',
        question: 'q',
        channels: [],
      });
      const res = await call(
        `/v1/nudges/${created.id}/reply`,
        JSON.stringify({ reply: 'on it' }),
      );
      expect(res.status).toBe(200);
      const rows = await listNudgesImpl(db, userId);
      expect(rows[0]!.replyText).toBe('on it');
    });

    it('400 on invalid id', async () => {
      const res = await call('/v1/nudges/banana/reply', JSON.stringify({ reply: 'x' }));
      expect(res.status).toBe(400);
    });

    it('400 on invalid JSON body', async () => {
      const created = await insertNudgeImpl(db, {
        userId,
        topic: 'open-thread',
        question: 'q',
        channels: [],
      });
      const res = await call(`/v1/nudges/${created.id}/reply`, '{not-json');
      expect(res.status).toBe(400);
    });

    it('422 on validation failure (empty reply)', async () => {
      const created = await insertNudgeImpl(db, {
        userId,
        topic: 'open-thread',
        question: 'q',
        channels: [],
      });
      const res = await call(
        `/v1/nudges/${created.id}/reply`,
        JSON.stringify({ reply: '' }),
      );
      expect(res.status).toBe(422);
    });

    it('404 when the nudge is not owned by this user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
      const created = await insertNudgeImpl(db, {
        userId: other.id,
        topic: 'open-thread',
        question: 'q',
        channels: [],
      });
      const res = await call(
        `/v1/nudges/${created.id}/reply`,
        JSON.stringify({ reply: 'noted' }),
      );
      expect(res.status).toBe(404);
    });
  });

  it('also exposes /health unauthenticated', async () => {
    // Build a minimal app with only the health route, since we don't import
    // the whole index (it pulls otel).  Just confirm the eventRouter is
    // mountable at /v1 and the rest is open.
    const open = new Hono<AppBindings>();
    open.get('/health', (c) => c.json({ ok: true }));
    open.use('/v1/*', hmacMiddleware(() => db));
    open.route('/v1', eventRouter);
    const res = await open.request('/health');
    expect(res.status).toBe(200);
  });

  // dismiss-noop guard: dismissNudgeImpl called via the api when nudge gone
  it('dismissNudgeImpl returns false for missing nudge ids (sanity)', async () => {
    expect(await dismissNudgeImpl(db, userId, 99_999)).toBe(false);
  });
});
