import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { remindersRouter } from '../../workers/api/src/handlers/reminders';
import { signRequest } from '~/lib/hmac';
import { createReminderImpl } from '~/server/nudge';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('nudge API (HMAC)', () => {
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
      INSERT INTO nudge.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id,
            name        = EXCLUDED.name
    `);
    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', remindersRouter);
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
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body: method === 'GET' ? undefined : body,
      },
      { HYPERDRIVE: {} } as unknown as Record<string, unknown>,
    );
  }

  describe('POST /v1/create', () => {
    it('creates with relative_seconds (snake_case)', async () => {
      const body = JSON.stringify({ text: 'water', relative_seconds: 600 });
      const res = await call('/v1/create', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: number; fireAt: string };
      expect(typeof json.id).toBe('number');
      const rows = (await db.execute(
        sql`SELECT user_id, text, source FROM nudge.reminders WHERE id = ${json.id}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      const row = list[0] as { user_id: number; text: string; source: string };
      expect(Number(row.user_id)).toBe(userId);
      expect(row.source).toBe('cli');
    });

    it('creates with fire_at (snake_case)', async () => {
      const body = JSON.stringify({
        text: 'water',
        fire_at: '2026-05-24T11:00:00.000Z',
      });
      const res = await call('/v1/create', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { fireAt: string };
      expect(json.fireAt).toBe('2026-05-24T11:00:00.000Z');
    });

    it('creates with camelCase fireAt + relativeSeconds', async () => {
      const body = JSON.stringify({ text: 'x', relativeSeconds: 30 });
      const res = await call('/v1/create', body);
      expect(res.status).toBe(201);
    });

    it('accepts recurrence', async () => {
      const body = JSON.stringify({
        text: 'water',
        relative_seconds: 60,
        recurrence: 'daily',
      });
      const res = await call('/v1/create', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { nextFireAt: string | null };
      expect(json.nextFireAt).not.toBeNull();
    });

    it('preserves explicit source', async () => {
      const body = JSON.stringify({ text: 'x', relative_seconds: 60, source: 'mobile' });
      const res = await call('/v1/create', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: number };
      const rows = (await db.execute(
        sql`SELECT source FROM nudge.reminders WHERE id = ${json.id}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { source: string }).source).toBe('mobile');
    });

    it('rejects without auth', async () => {
      const res = await app.request('/v1/create', { method: 'POST', body: '{}' });
      expect(res.status).toBe(401);
    });

    it('rejects invalid timestamp', async () => {
      const res = await app.request('/v1/create', {
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

    it('rejects unknown client', async () => {
      const body = '{}';
      const { ts, sig } = await sign(body);
      const res = await app.request('/v1/create', {
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

    it('rejects bad signature', async () => {
      const body = '{}';
      const ts = Date.now();
      const res = await app.request('/v1/create', {
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

    it('400 on invalid JSON', async () => {
      const res = await call('/v1/create', '{not-json');
      expect(res.status).toBe(400);
    });

    it('422 when text is missing', async () => {
      const res = await call('/v1/create', JSON.stringify({ relative_seconds: 60 }));
      expect(res.status).toBe(422);
    });

    it('422 when fire_at/relative_seconds both missing', async () => {
      const res = await call('/v1/create', JSON.stringify({ text: 'x' }));
      expect(res.status).toBe(422);
    });

    it('422 on empty body (parses as {})', async () => {
      const res = await call('/v1/create', '');
      expect(res.status).toBe(422);
    });
  });

  describe('GET /v1/upcoming', () => {
    it('returns user reminders within default 24h', async () => {
      await createReminderImpl(db, userId, { text: 'a', relativeSeconds: 60 });
      await createReminderImpl(db, userId, { text: 'b', relativeSeconds: 120 });
      const res = await call('/v1/upcoming', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { reminders: Array<{ text: string }> };
      expect(json.reminders.length).toBe(2);
    });

    it('respects within=', async () => {
      await createReminderImpl(db, userId, { text: 'near', relativeSeconds: 60 });
      await createReminderImpl(db, userId, { text: 'far', relativeSeconds: 60 * 60 * 48 });
      const res = await call('/v1/upcoming?within=3600', '', { method: 'GET' });
      const json = (await res.json()) as { reminders: Array<{ text: string }> };
      expect(json.reminders.length).toBe(1);
    });

    it('400 on invalid within', async () => {
      const res = await call('/v1/upcoming?within=banana', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/dismiss', () => {
    it('dismisses an owned reminder', async () => {
      const r = await createReminderImpl(db, userId, { text: 'x', relativeSeconds: 60 });
      const res = await call('/v1/dismiss', JSON.stringify({ id: r.id }));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { dismissed: number };
      expect(json.dismissed).toBe(r.id);
    });
    it('404 for missing id', async () => {
      const res = await call('/v1/dismiss', JSON.stringify({ id: 99999 }));
      expect(res.status).toBe(404);
    });
    it('422 for missing id field', async () => {
      const res = await call('/v1/dismiss', JSON.stringify({}));
      expect(res.status).toBe(422);
    });
    it('400 for invalid JSON', async () => {
      const res = await call('/v1/dismiss', '{not-json');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/snooze', () => {
    it('snoozes a reminder', async () => {
      const r = await createReminderImpl(db, userId, { text: 'x', relativeSeconds: 60 });
      const res = await call('/v1/snooze', JSON.stringify({ id: r.id, minutes: 15 }));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { reminder: { id: number; fireAt: string } };
      expect(json.reminder.id).toBe(r.id);
    });
    it('404 for missing id', async () => {
      const res = await call('/v1/snooze', JSON.stringify({ id: 99999, minutes: 15 }));
      expect(res.status).toBe(404);
    });
    it('422 for missing minutes', async () => {
      const res = await call('/v1/snooze', JSON.stringify({ id: 1 }));
      expect(res.status).toBe(422);
    });
    it('400 for invalid JSON', async () => {
      const res = await call('/v1/snooze', '{not-json');
      expect(res.status).toBe(400);
    });
  });

  describe('POST /v1/delete', () => {
    it('deletes a reminder', async () => {
      const r = await createReminderImpl(db, userId, { text: 'x', relativeSeconds: 60 });
      const res = await call('/v1/delete', JSON.stringify({ id: r.id }));
      expect(res.status).toBe(200);
      const json = (await res.json()) as { deleted: number };
      expect(json.deleted).toBe(r.id);
    });
    it('404 for missing id', async () => {
      const res = await call('/v1/delete', JSON.stringify({ id: 99999 }));
      expect(res.status).toBe(404);
    });
    it('422 for missing id field', async () => {
      const res = await call('/v1/delete', JSON.stringify({}));
      expect(res.status).toBe(422);
    });
    it('400 for invalid JSON', async () => {
      const res = await call('/v1/delete', '{not-json');
      expect(res.status).toBe(400);
    });
  });
});
