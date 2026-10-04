import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { sessionsRouter } from '../../workers/api/src/handlers/sessions';
import { signRequest } from '~/lib/hmac';
import { startSessionImpl } from '~/server/focus';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('focus API (HMAC)', () => {
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
      INSERT INTO focus.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
    `);

    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', sessionsRouter);
  });

  async function sign(body: string): Promise<{ ts: number; sig: string }> {
    const ts = Date.now();
    const sig = await signRequest(secret, body, ts);
    return { ts, sig };
  }

  async function call(path: string, body: string, init: { method?: string } = {}): Promise<Response> {
    const { ts, sig } = await sign(body);
    return await app.request(
      path,
      {
        method: init.method ?? 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body: init.method === 'GET' ? undefined : body,
      },
      { HYPERDRIVE: {} } as unknown as Record<string, unknown>,
    );
  }

  // ---------- /v1/start ----------

  describe('POST /v1/start', () => {
    it('creates a session with valid HMAC', async () => {
      const body = JSON.stringify({ taskText: 'fix auth', targetMinutes: 25 });
      const res = await call('/v1/start', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: number; startedAt: string; endsAt: string };
      expect(typeof json.id).toBe('number');
      const rows = (await db.execute(
        sql`SELECT user_id, task_text, target_minutes FROM focus.sessions WHERE id = ${json.id}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      const row = list[0] as { user_id: number; task_text: string; target_minutes: number };
      expect(row.user_id).toBe(userId);
      expect(row.task_text).toBe('fix auth');
      expect(row.target_minutes).toBe(25);
    });

    it('rejects without auth headers', async () => {
      const res = await app.request('/v1/start', {
        method: 'POST',
        body: JSON.stringify({ taskText: 'x' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects with an invalid timestamp', async () => {
      const res = await app.request('/v1/start', {
        method: 'POST',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': 'not-a-number',
          'X-Signature': 'AAAA',
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });

    it('rejects with an unknown client_id', async () => {
      const body = '{"taskText":"x"}';
      const { ts, sig } = await sign(body);
      const res = await app.request('/v1/start', {
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

    it('rejects with a bad signature', async () => {
      const body = '{"taskText":"x"}';
      const ts = Date.now();
      const res = await app.request('/v1/start', {
        method: 'POST',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': 'AAAA',
        },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('422 on validation failure', async () => {
      const res = await call('/v1/start', JSON.stringify({ taskText: '' }));
      expect(res.status).toBe(422);
    });

    it('422 on empty body', async () => {
      const res = await call('/v1/start', '');
      expect(res.status).toBe(422);
    });

    it('400 on invalid JSON body', async () => {
      const res = await call('/v1/start', '{not-json');
      expect(res.status).toBe(400);
    });
  });

  // ---------- /v1/end ----------

  describe('POST /v1/end', () => {
    it('completes a session', async () => {
      const r = await startSessionImpl(db, userId, { taskText: 'fix me', targetMinutes: 25 });
      const res = await call(
        '/v1/end',
        JSON.stringify({ sessionId: r.id, endedReason: 'completed', satisfaction: 4 }),
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { endedReason: string };
      expect(json.endedReason).toBe('completed');
    });

    it('404 when the session does not belong to the api_client user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
      const r = await startSessionImpl(db, other.id, { taskText: 'mallory', targetMinutes: 25 });
      const res = await call(
        '/v1/end',
        JSON.stringify({ sessionId: r.id, endedReason: 'completed' }),
      );
      expect(res.status).toBe(404);
    });

    it('422 on validation failure', async () => {
      const res = await call(
        '/v1/end',
        JSON.stringify({ sessionId: 'not a number', endedReason: 'completed' }),
      );
      expect(res.status).toBe(422);
    });

    it('400 on invalid JSON', async () => {
      const res = await call('/v1/end', '{not-json');
      expect(res.status).toBe(400);
    });
  });

  // ---------- /v1/distract ----------

  describe('POST /v1/distract', () => {
    it('logs a wobble against the user\'s session', async () => {
      const r = await startSessionImpl(db, userId, { taskText: 'fix me', targetMinutes: 25 });
      const res = await call(
        '/v1/distract',
        JSON.stringify({ sessionId: r.id, label: 'twitter' }),
      );
      expect(res.status).toBe(201);
      const rows = (await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM focus.distractions WHERE session_id = ${r.id}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { c: number }).c).toBe(1);
    });

    it('404 when the session belongs to another user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
      const r = await startSessionImpl(db, other.id, { taskText: 'mallory', targetMinutes: 25 });
      const res = await call(
        '/v1/distract',
        JSON.stringify({ sessionId: r.id, label: 'twitter' }),
      );
      expect(res.status).toBe(404);
    });

    it('422 on validation failure', async () => {
      const res = await call('/v1/distract', JSON.stringify({ sessionId: 1, label: '' }));
      expect(res.status).toBe(422);
    });

    it('400 on invalid JSON', async () => {
      const res = await call('/v1/distract', '{not-json');
      expect(res.status).toBe(400);
    });
  });

  // ---------- /v1/active ----------

  describe('GET /v1/active', () => {
    it('returns null when no session is active', async () => {
      const res = await call('/v1/active', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { active: unknown };
      expect(json.active).toBeNull();
    });

    it('returns the active session for the api_client\'s user', async () => {
      const r = await startSessionImpl(db, userId, { taskText: 'fix me', targetMinutes: 25 });
      const res = await call('/v1/active', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { active: { id: number; taskText: string } | null };
      expect(json.active?.id).toBe(r.id);
      expect(json.active?.taskText).toBe('fix me');
    });
  });
});
