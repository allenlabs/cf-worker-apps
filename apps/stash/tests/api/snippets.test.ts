import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { snippetsRouter } from '../../workers/api/src/handlers/snippets';
import { signRequest } from '~/lib/hmac';
import { saveSnippetImpl } from '~/server/stash';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('stash API (HMAC)', () => {
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
      INSERT INTO stash.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id,
            name        = EXCLUDED.name
    `);

    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', snippetsRouter);
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
    it('creates a snippet with valid HMAC', async () => {
      const body = JSON.stringify({
        title: 'curl example',
        body: 'curl example.com',
        language: 'sh',
        tags: ['curl'],
      });
      const res = await call('/v1/save', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: number; title: string; createdAt: string };
      expect(typeof json.id).toBe('number');
      expect(json.title).toBe('curl example');

      const rows = (await db.execute(
        sql`SELECT user_id, title, body, source FROM stash.snippets WHERE id = ${json.id}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      const row = list[0] as { user_id: number; title: string; body: string; source: string };
      expect(Number(row.user_id)).toBe(userId);
      expect(row.title).toBe('curl example');
      expect(row.body).toBe('curl example.com');
      expect(row.source).toBe('cli'); // stamps the client_id when missing
    });

    it('rejects without auth headers', async () => {
      const res = await app.request('/v1/save', {
        method: 'POST',
        body: JSON.stringify({ body: 'x' }),
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

    it('rejects with an unknown client_id', async () => {
      const body = '{"body":"x"}';
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

    it('rejects with a bad signature', async () => {
      const body = '{"body":"x"}';
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
      const res = await call('/v1/save', JSON.stringify({ body: '' }));
      expect(res.status).toBe(422);
    });

    it('422 on empty body', async () => {
      const res = await call('/v1/save', '');
      expect(res.status).toBe(422);
    });

    it('400 on invalid JSON', async () => {
      const res = await call('/v1/save', '{not-json');
      expect(res.status).toBe(400);
    });

    it('preserves an explicit source field', async () => {
      const body = JSON.stringify({ body: 'x', source: 'mobile' });
      const res = await call('/v1/save', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: number };
      const rows = (await db.execute(
        sql`SELECT source FROM stash.snippets WHERE id = ${json.id}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { source: string }).source).toBe('mobile');
    });
  });

  // ---------- /v1/search ----------

  describe('GET /v1/search', () => {
    it('returns hits for a body match', async () => {
      await saveSnippetImpl(db, userId, { body: 'curl example.com' });
      await saveSnippetImpl(db, userId, { body: 'docker compose up' });
      const res = await call('/v1/search?q=curl', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { hits: Array<{ body: string }> };
      expect(json.hits.length).toBe(1);
      expect(json.hits[0]!.body).toMatch(/curl/);
    });

    it('400 on a missing q', async () => {
      const res = await call('/v1/search', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('400 on a very long q', async () => {
      const q = 'a'.repeat(401);
      const res = await call(`/v1/search?q=${encodeURIComponent(q)}`, '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('400 on a non-numeric limit', async () => {
      const res = await call('/v1/search?q=x&limit=banana', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('honours the limit', async () => {
      for (let i = 0; i < 3; i++) {
        await saveSnippetImpl(db, userId, { body: `curl ${i}` });
      }
      const res = await call('/v1/search?q=curl&limit=2', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { hits: unknown[] };
      expect(json.hits.length).toBe(2);
    });
  });

  // ---------- /v1/get ----------

  describe('GET /v1/get', () => {
    it('returns the snippet for the owning user', async () => {
      const saved = await saveSnippetImpl(db, userId, {
        body: 'x',
        title: 't',
      });
      const res = await call(`/v1/get?id=${saved.id}`, '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { id: number; title: string };
      expect(json.id).toBe(saved.id);
      expect(json.title).toBe('t');
    });

    it('400 on a non-numeric id', async () => {
      const res = await call('/v1/get?id=banana', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('400 on a missing id', async () => {
      const res = await call('/v1/get', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('400 on an id of 0', async () => {
      const res = await call('/v1/get?id=0', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('404 when not owned by this client\'s user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
      const saved = await saveSnippetImpl(db, other.id, { body: 'x' });
      const res = await call(`/v1/get?id=${saved.id}`, '', { method: 'GET' });
      expect(res.status).toBe(404);
    });
  });

  // ---------- /v1/delete ----------

  describe('POST /v1/delete', () => {
    it('deletes the snippet', async () => {
      const saved = await saveSnippetImpl(db, userId, { body: 'x' });
      const res = await call('/v1/delete', JSON.stringify({ id: saved.id }));
      expect(res.status).toBe(200);
      const remaining = (await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM stash.snippets WHERE id = ${saved.id}`,
      )) as unknown;
      const list = Array.isArray(remaining) ? remaining : (remaining as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { c: number }).c).toBe(0);
    });

    it('400 on invalid JSON', async () => {
      const res = await call('/v1/delete', '{not-json');
      expect(res.status).toBe(400);
    });

    it('422 on missing id', async () => {
      const res = await call('/v1/delete', '{}');
      expect(res.status).toBe(422);
    });

    it('404 when not owned by this client\'s user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-m' });
      const saved = await saveSnippetImpl(db, other.id, { body: 'x' });
      const res = await call('/v1/delete', JSON.stringify({ id: saved.id }));
      expect(res.status).toBe(404);
    });
  });
});
