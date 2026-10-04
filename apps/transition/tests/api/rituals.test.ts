import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { ritualsRouter } from '../../workers/api/src/handlers/rituals';
import { signRequest } from '~/lib/hmac';
import { saveRitualImpl } from '~/server/transition';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('transition API (HMAC)', () => {
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
      INSERT INTO transition.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id
    `);
    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', ritualsRouter);
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

  describe('POST /v1/save', () => {
    it('saves a ritual', async () => {
      const body = JSON.stringify({ leaving_at: 'audit', next_step: 'PR' });
      const res = await call('/v1/save', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { ritual: { leavingAt: string } };
      expect(json.ritual.leavingAt).toBe('audit');
    });
    it('rejects without auth', async () => {
      const res = await app.request('/v1/save', { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
    });
    it('400 on invalid JSON', async () => {
      const res = await call('/v1/save', '{not-json');
      expect(res.status).toBe(400);
    });
    it('422 on missing fields', async () => {
      const res = await call('/v1/save', JSON.stringify({ leaving_at: '' }));
      expect(res.status).toBe(422);
    });
    it('422 on empty body', async () => {
      const res = await call('/v1/save', '');
      expect(res.status).toBe(422);
    });
    it('401 on bad signature', async () => {
      const ts = Date.now();
      const res = await app.request('/v1/save', {
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
      const res = await app.request('/v1/save', {
        method: 'POST',
        headers: { 'X-Client-Id': 'ghost', 'X-Timestamp': String(ts), 'X-Signature': sig },
        body,
      });
      expect(res.status).toBe(401);
    });
    it('401 on invalid timestamp', async () => {
      const res = await app.request('/v1/save', {
        method: 'POST',
        headers: { 'X-Client-Id': 'cli', 'X-Timestamp': 'nope', 'X-Signature': 'AAAA' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/recent', () => {
    it('returns recent rituals', async () => {
      await saveRitualImpl(db, userId, { leaving_at: 'l', next_step: 'n' });
      const res = await call('/v1/recent?limit=10', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { rituals: unknown[] };
      expect(json.rituals.length).toBe(1);
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
});
