import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { intentRouter } from '../../workers/api/src/handlers/intent';
import { signRequest } from '~/lib/hmac';
import { setIntentImpl } from '~/server/intent';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('intent API (HMAC)', () => {
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
      INSERT INTO intent.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id
    `);
    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', intentRouter);
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

  describe('POST /v1/set', () => {
    it('saves an intent', async () => {
      const body = JSON.stringify({ text: 'reviewing PRs' });
      const res = await call('/v1/set', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { current: { text: string } };
      expect(json.current.text).toBe('reviewing PRs');
    });
    it('overwrites prior intent', async () => {
      await call('/v1/set', JSON.stringify({ text: 'first' }));
      const res = await call('/v1/set', JSON.stringify({ text: 'second' }));
      expect(res.status).toBe(201);
      const json = (await res.json()) as { current: { text: string } };
      expect(json.current.text).toBe('second');
    });
    it('rejects without auth', async () => {
      const res = await app.request('/v1/set', { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
    });
    it('400 on invalid JSON', async () => {
      const res = await call('/v1/set', '{not-json');
      expect(res.status).toBe(400);
    });
    it('422 on too-long text', async () => {
      const res = await call('/v1/set', JSON.stringify({ text: 'x'.repeat(281) }));
      expect(res.status).toBe(422);
    });
    it('422 on empty body (parses as {})', async () => {
      const res = await call('/v1/set', '');
      expect(res.status).toBe(422);
    });
    it('401 on bad signature', async () => {
      const ts = Date.now();
      const res = await app.request('/v1/set', {
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
      const res = await app.request('/v1/set', {
        method: 'POST',
        headers: { 'X-Client-Id': 'ghost', 'X-Timestamp': String(ts), 'X-Signature': sig },
        body,
      });
      expect(res.status).toBe(401);
    });
    it('401 on invalid timestamp', async () => {
      const res = await app.request('/v1/set', {
        method: 'POST',
        headers: { 'X-Client-Id': 'cli', 'X-Timestamp': 'nope', 'X-Signature': 'AAAA' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/current', () => {
    it('returns empty when not set', async () => {
      const res = await call('/v1/current', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { current: { text: string } };
      expect(json.current.text).toBe('');
    });
    it('returns the saved intent', async () => {
      await setIntentImpl(db, userId, { text: 'focused' });
      const res = await call('/v1/current', '', { method: 'GET' });
      const json = (await res.json()) as { current: { text: string } };
      expect(json.current.text).toBe('focused');
    });
  });

  describe('GET /v1/history', () => {
    it('returns history DESC', async () => {
      await setIntentImpl(db, userId, { text: 'one' }, new Date('2026-05-24T10:00:00Z'));
      await setIntentImpl(db, userId, { text: 'two' }, new Date('2026-05-24T11:00:00Z'));
      const res = await call('/v1/history?limit=10', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { history: Array<{ text: string }> };
      expect(json.history.length).toBe(2);
      expect(json.history[0]!.text).toBe('two');
    });
    it('defaults to limit=50', async () => {
      const res = await call('/v1/history', '', { method: 'GET' });
      expect(res.status).toBe(200);
    });
    it('400 on invalid limit', async () => {
      const res = await call('/v1/history?limit=nope', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
    it('400 on zero limit', async () => {
      const res = await call('/v1/history?limit=0', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });
});
