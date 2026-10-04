import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { entriesRouter } from '../../workers/api/src/handlers/entries';
import { signRequest } from '~/lib/hmac';
import { upsertCheckinImpl } from '~/server/journal';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('journal API (HMAC)', () => {
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
      INSERT INTO journal.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id
    `);
    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', entriesRouter);
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

  describe('POST /v1/checkin', () => {
    it('creates an entry + stamps client_id as source', async () => {
      const body = JSON.stringify({ mood: 4, energy: 3, focus: 5 });
      const res = await call('/v1/checkin', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { entry: { mood: number; source: string } };
      expect(json.entry.mood).toBe(4);
      expect(json.entry.source).toBe('cli');
    });

    it('preserves explicit source', async () => {
      const body = JSON.stringify({ mood: 3, energy: 3, focus: 3, source: 'mobile' });
      const res = await call('/v1/checkin', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { entry: { source: string } };
      expect(json.entry.source).toBe('mobile');
    });

    it('rejects without auth', async () => {
      const res = await app.request('/v1/checkin', { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
    });

    it('400 on invalid JSON', async () => {
      const res = await call('/v1/checkin', '{not-json');
      expect(res.status).toBe(400);
    });

    it('422 on out-of-range', async () => {
      const res = await call('/v1/checkin', JSON.stringify({ mood: 9, energy: 3, focus: 3 }));
      expect(res.status).toBe(422);
    });

    it('422 on empty body (parses as {})', async () => {
      const res = await call('/v1/checkin', '');
      expect(res.status).toBe(422);
    });

    it('401 on bad signature', async () => {
      const ts = Date.now();
      const res = await app.request('/v1/checkin', {
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
      const res = await app.request('/v1/checkin', {
        method: 'POST',
        headers: { 'X-Client-Id': 'ghost', 'X-Timestamp': String(ts), 'X-Signature': sig },
        body,
      });
      expect(res.status).toBe(401);
    });

    it('401 on invalid timestamp', async () => {
      const res = await app.request('/v1/checkin', {
        method: 'POST',
        headers: { 'X-Client-Id': 'cli', 'X-Timestamp': 'nope', 'X-Signature': 'AAAA' },
        body: '{}',
      });
      expect(res.status).toBe(401);
    });
  });

  describe('GET /v1/today', () => {
    it('returns null when no entry', async () => {
      const res = await call('/v1/today', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { entry: unknown };
      expect(json.entry).toBeNull();
    });
    it('returns today\'s entry', async () => {
      await upsertCheckinImpl(db, userId, { mood: 4, energy: 4, focus: 4 });
      const res = await call('/v1/today', '', { method: 'GET' });
      const json = (await res.json()) as { entry: { mood: number } };
      expect(json.entry.mood).toBe(4);
    });
  });

  describe('GET /v1/range', () => {
    it('returns entries between dates', async () => {
      await upsertCheckinImpl(db, userId, { mood: 3, energy: 3, focus: 3, date: '2026-05-22' });
      await upsertCheckinImpl(db, userId, { mood: 3, energy: 3, focus: 3, date: '2026-05-24' });
      const res = await call('/v1/range?from=2026-05-21&to=2026-05-25', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { entries: unknown[] };
      expect(json.entries.length).toBe(2);
    });
    it('400 on malformed range', async () => {
      const res = await call('/v1/range?from=bad', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
    it('400 when to < from', async () => {
      const res = await call('/v1/range?from=2026-05-24&to=2026-05-22', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });

  describe('GET /v1/stats', () => {
    it('returns total / averages / heatmap', async () => {
      const res = await call('/v1/stats', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { total: number; heatmap: unknown[] };
      expect(json.total).toBe(0);
      expect(json.heatmap.length).toBe(90);
    });
  });

  describe('GET /v1/entry', () => {
    it('returns the entry', async () => {
      await upsertCheckinImpl(db, userId, { mood: 3, energy: 3, focus: 3, date: '2026-05-22' });
      const res = await call('/v1/entry?date=2026-05-22', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { entry: { mood: number } };
      expect(json.entry.mood).toBe(3);
    });
    it('404 when missing', async () => {
      const res = await call('/v1/entry?date=2026-05-22', '', { method: 'GET' });
      expect(res.status).toBe(404);
    });
    it('400 on invalid date', async () => {
      const res = await call('/v1/entry?date=bad', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
    it('400 without date', async () => {
      const res = await call('/v1/entry', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });
});
