import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { itemsRouter } from '../../workers/api/src/handlers/items';
import { signRequest } from '~/lib/hmac';
import { saveItemImpl } from '~/server/read-later';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('read-later API (HMAC)', () => {
  let db: TestDB;
  let userId: number;
  let secret: string;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    db = await makeTestDb();
    const u = await insertPmUser(db, { login: 'alice' });
    userId = u.id;
    secret = 'unit-test-secret-32-bytes-long-aaa';
    // Replace the migration's auto-seeded 'cli' row with one we know the
    // secret for (the migration uses gen_random_bytes which we can't
    // recover).  ON CONFLICT updates in place.
    await db.execute(sql`
      INSERT INTO read_later.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id,
            name        = EXCLUDED.name
    `);

    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', itemsRouter);
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

  // ---------- /v1/save ----------

  describe('POST /v1/save', () => {
    it('creates an item with valid HMAC', async () => {
      const body = JSON.stringify({
        url: 'https://example.com/article',
        title: 'Manual Title',
        tags: ['rust'],
      });
      const res = await call('/v1/save', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: number; url: string };
      expect(typeof json.id).toBe('number');
      expect(json.url).toBe('https://example.com/article');

      const rows = (await db.execute(
        sql`SELECT user_id, url, source, tags FROM read_later.items WHERE id = ${json.id}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      const row = list[0] as { user_id: number; url: string; source: string; tags: string[] };
      expect(Number(row.user_id)).toBe(userId);
      expect(row.source).toBe('api');
      expect(row.tags).toEqual(['rust']);
    });

    it('rejects without auth headers', async () => {
      const res = await app.request('/v1/save', {
        method: 'POST',
        body: JSON.stringify({ url: 'https://x.com' }),
      });
      expect(res.status).toBe(401);
    });

    it('rejects with an invalid timestamp', async () => {
      const res = await app.request('/v1/save', {
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

    it('rejects an unknown client_id', async () => {
      const body = '{"url":"https://x.com"}';
      const { ts, sig } = await sign(body);
      const res = await app.request('/v1/save', {
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

    it('rejects a bad signature', async () => {
      const body = '{"url":"https://x.com"}';
      const ts = Date.now();
      const res = await app.request('/v1/save', {
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
      const res = await call('/v1/save', JSON.stringify({ url: 'not-a-url' }));
      expect(res.status).toBe(422);
    });

    it('400 on invalid JSON body', async () => {
      const res = await call('/v1/save', '{not-json');
      expect(res.status).toBe(400);
    });

    it('422 on empty body (parsed as {} and fails validation)', async () => {
      const res = await call('/v1/save', '');
      expect(res.status).toBe(422);
    });
  });

  // ---------- /v1/next ----------

  describe('GET /v1/next', () => {
    it('returns the next unread item', async () => {
      await saveItemImpl(db, userId, { url: 'https://a.com' }, new Date('2026-05-24T09:00:00Z'));
      await saveItemImpl(db, userId, { url: 'https://b.com' }, new Date('2026-05-24T09:01:00Z'));
      const res = await call('/v1/next', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { item: { url: string } };
      expect(json.item.url).toBe('https://a.com');
    });

    it('returns item=null when nothing queued', async () => {
      const res = await call('/v1/next', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { item: null };
      expect(json.item).toBeNull();
    });

    it('honours ?freeMinutes', async () => {
      const long = await saveItemImpl(db, userId, { url: 'https://long.com' }, new Date('2026-05-24T09:00:00Z'));
      await db.execute(sql`UPDATE read_later.items SET estimated_minutes = 30 WHERE id = ${long.id}`);
      const short = await saveItemImpl(db, userId, { url: 'https://short.com' }, new Date('2026-05-24T09:05:00Z'));
      await db.execute(sql`UPDATE read_later.items SET estimated_minutes = 5 WHERE id = ${short.id}`);
      const res = await call('/v1/next?freeMinutes=10', '', { method: 'GET' });
      const json = (await res.json()) as { item: { url: string } };
      expect(json.item.url).toBe('https://short.com');
    });

    it('400 on invalid freeMinutes', async () => {
      const res = await call('/v1/next?freeMinutes=banana', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('400 on non-positive freeMinutes', async () => {
      const res = await call('/v1/next?freeMinutes=0', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });

  // ---------- /v1/done ----------

  describe('POST /v1/done', () => {
    it('marks the item as read', async () => {
      const r = await saveItemImpl(db, userId, { url: 'https://x.com' });
      const res = await call('/v1/done', JSON.stringify({ id: r.id }));
      expect(res.status).toBe(200);
    });
    it('404 when not found', async () => {
      const res = await call('/v1/done', JSON.stringify({ id: 99_999 }));
      expect(res.status).toBe(404);
    });
    it('422 on bad payload', async () => {
      const res = await call('/v1/done', JSON.stringify({ id: -1 }));
      expect(res.status).toBe(422);
    });
    it('400 on invalid JSON', async () => {
      const res = await call('/v1/done', '{not-json');
      expect(res.status).toBe(400);
    });
  });

  // ---------- /v1/skip ----------

  describe('POST /v1/skip', () => {
    it('bumps the skip count', async () => {
      const r = await saveItemImpl(db, userId, { url: 'https://x.com' });
      const res = await call('/v1/skip', JSON.stringify({ id: r.id }));
      expect(res.status).toBe(200);
    });
    it('404 when not found', async () => {
      const res = await call('/v1/skip', JSON.stringify({ id: 99_999 }));
      expect(res.status).toBe(404);
    });
    it('422 on bad payload', async () => {
      const res = await call('/v1/skip', JSON.stringify({}));
      expect(res.status).toBe(422);
    });
    it('400 on invalid JSON', async () => {
      const res = await call('/v1/skip', '{');
      expect(res.status).toBe(400);
    });
  });

  // ---------- /v1/delete ----------

  describe('POST /v1/delete', () => {
    it('deletes the item', async () => {
      const r = await saveItemImpl(db, userId, { url: 'https://x.com' });
      const res = await call('/v1/delete', JSON.stringify({ id: r.id }));
      expect(res.status).toBe(200);
      const remaining = (await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM read_later.items WHERE id = ${r.id}`,
      )) as unknown;
      const list = Array.isArray(remaining) ? remaining : (remaining as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { c: number }).c).toBe(0);
    });
    it('404 when not found', async () => {
      const res = await call('/v1/delete', JSON.stringify({ id: 99_999 }));
      expect(res.status).toBe(404);
    });
    it('422 on bad payload', async () => {
      const res = await call('/v1/delete', JSON.stringify({}));
      expect(res.status).toBe(422);
    });
    it('400 on invalid JSON', async () => {
      const res = await call('/v1/delete', '{');
      expect(res.status).toBe(400);
    });
  });
});
