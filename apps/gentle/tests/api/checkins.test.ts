import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { checkinsRouter } from '../../workers/api/src/handlers/checkins';
import { signRequest } from '~/lib/hmac';
import { upsertCheckinImpl } from '~/server/gentle';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('gentle API (HMAC)', () => {
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
      INSERT INTO gentle.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id
    `);
    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', checkinsRouter);
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
    it('creates an entry with the supplied toggles', async () => {
      const body = JSON.stringify({ slept_ok: true, meds: false, ate: true });
      const res = await call('/v1/checkin', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { entry: { sleptOk: boolean; meds: boolean; ate: boolean } };
      expect(json.entry.sleptOk).toBe(true);
      expect(json.entry.meds).toBe(false);
      expect(json.entry.ate).toBe(true);
    });

    it('accepts an empty body (creates a "I showed up" row)', async () => {
      const res = await call('/v1/checkin', '');
      expect(res.status).toBe(201);
      const json = (await res.json()) as { entry: { sleptOk: boolean | null } };
      expect(json.entry.sleptOk).toBeNull();
    });

    it('rejects without auth', async () => {
      const res = await app.request('/v1/checkin', { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
    });

    it('400 on invalid JSON', async () => {
      const res = await call('/v1/checkin', '{not-json');
      expect(res.status).toBe(400);
    });

    it('422 on bad type', async () => {
      const res = await call('/v1/checkin', JSON.stringify({ slept_ok: 'yes' }));
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
    it('null when no entry', async () => {
      const res = await call('/v1/today', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { entry: unknown };
      expect(json.entry).toBeNull();
    });

    it("returns today's entry", async () => {
      await upsertCheckinImpl(db, userId, { slept_ok: true });
      const res = await call('/v1/today', '', { method: 'GET' });
      const json = (await res.json()) as { entry: { sleptOk: boolean } };
      expect(json.entry.sleptOk).toBe(true);
    });
  });

  describe('GET /v1/range', () => {
    it('returns entries between dates', async () => {
      await upsertCheckinImpl(db, userId, { slept_ok: true, date: '2026-05-22' });
      await upsertCheckinImpl(db, userId, { slept_ok: false, date: '2026-05-24' });
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
});
