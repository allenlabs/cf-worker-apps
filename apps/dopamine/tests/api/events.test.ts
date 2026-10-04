import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { eventsRouter } from '../../workers/api/src/handlers/events';
import { signRequest } from '~/lib/hmac';
import { createEventImpl } from '~/server/dopamine';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('dopamine API (HMAC)', () => {
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
      INSERT INTO dopamine.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id
    `);
    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', eventsRouter);
  });

  async function sign(body: string): Promise<{ ts: number; sig: string }> {
    const ts = Date.now();
    const sig = await signRequest(secret, body, ts);
    return { ts, sig };
  }

  async function call(path: string, body: string, init: { method?: string } = {}): Promise<Response> {
    const { ts, sig } = await sign(body);
    const method = init.method ?? 'POST';
    return await app.request(
      path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body: method === 'GET' ? undefined : body,
      },
      { HYPERDRIVE: {} } as unknown as Record<string, unknown>,
    );
  }

  describe('POST /v1/event', () => {
    it('creates an event', async () => {
      const body = JSON.stringify({ kind: 'pr_merged', title: 'shipped', importance: 2 });
      const res = await call('/v1/event', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { event: { title: string; importance: number } };
      expect(json.event.title).toBe('shipped');
      expect(json.event.importance).toBe(2);
    });
    it('rejects without auth', async () => {
      const res = await app.request('/v1/event', { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
    });
    it('400 on invalid JSON', async () => {
      const res = await call('/v1/event', '{not-json');
      expect(res.status).toBe(400);
    });
    it('422 on unknown kind', async () => {
      const res = await call('/v1/event', JSON.stringify({ kind: 'foo', title: 'x' }));
      expect(res.status).toBe(422);
    });
    it('422 on empty body', async () => {
      const res = await call('/v1/event', '');
      expect(res.status).toBe(422);
    });
    it('401 on bad signature', async () => {
      const ts = Date.now();
      const res = await app.request('/v1/event', {
        method: 'POST',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': 'AAAA',
        },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });
    it('401 on unknown client', async () => {
      const body = '{}';
      const { ts, sig } = await sign(body);
      const res = await app.request('/v1/event', {
        method: 'POST',
        headers: { 'X-Client-Id': 'ghost', 'X-Timestamp': String(ts), 'X-Signature': sig },
        body,
      });
      expect(res.status).toBe(401);
    });
    it('401 on invalid timestamp', async () => {
      const res = await app.request('/v1/event', {
        method: 'POST',
        headers: { 'X-Client-Id': 'cli', 'X-Timestamp': 'nope', 'X-Signature': 'AAAA' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/recent', () => {
    it('returns recent events', async () => {
      await createEventImpl(db, userId, { kind: 'pr_merged', title: 'one' });
      const res = await call('/v1/recent?limit=10', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { events: Array<{ title: string }> };
      expect(json.events.length).toBe(1);
    });
    it('default limit', async () => {
      const res = await call('/v1/recent', '', { method: 'GET' });
      expect(res.status).toBe(200);
    });
    it('400 on invalid limit', async () => {
      const res = await call('/v1/recent?limit=bad', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
    it('400 on zero limit', async () => {
      const res = await call('/v1/recent?limit=0', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/random', () => {
    it('returns null event when empty', async () => {
      const res = await call('/v1/random', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { event: unknown };
      expect(json.event).toBeNull();
    });
    it('returns an event', async () => {
      await createEventImpl(db, userId, { kind: 'pr_merged', title: 'won' });
      const res = await call('/v1/random?since_days=30', '', { method: 'GET' });
      const json = (await res.json()) as { event: { title: string } };
      expect(json.event.title).toBe('won');
    });
    it('400 on invalid since_days', async () => {
      const res = await call('/v1/random?since_days=bad', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
    it('400 on zero since_days', async () => {
      const res = await call('/v1/random?since_days=0', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });
});
