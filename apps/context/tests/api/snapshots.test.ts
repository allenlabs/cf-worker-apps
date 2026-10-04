import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { snapshotsRouter } from '../../workers/api/src/handlers/snapshots';
import { signRequest } from '~/lib/hmac';
import { saveSnapshotImpl } from '~/server/context';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('context API (HMAC)', () => {
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
      INSERT INTO context.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
      ON CONFLICT (client_id) DO UPDATE
        SET hmac_secret = EXCLUDED.hmac_secret,
            user_id     = EXCLUDED.user_id,
            name        = EXCLUDED.name
    `);

    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', snapshotsRouter);
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
        body: method === 'GET' || method === 'DELETE' ? undefined : body,
      },
      { HYPERDRIVE: {} } as unknown as Record<string, unknown>,
    );
  }

  // ---------- /v1/save ----------

  describe('POST /v1/save', () => {
    it('creates a snapshot with valid HMAC', async () => {
      const body = JSON.stringify({
        name: 'fixing auth',
        payload: { cwd: '/x', branch: 'main' },
      });
      const res = await call('/v1/save', body);
      expect(res.status).toBe(201);
      const json = (await res.json()) as { id: number; name: string; createdAt: string };
      expect(typeof json.id).toBe('number');
      expect(json.name).toBe('fixing auth');

      const rows = (await db.execute(
        sql`SELECT user_id, name, payload FROM context.snapshots WHERE id = ${json.id}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      const row = list[0] as { user_id: number; name: string; payload: Record<string, unknown> };
      expect(row.user_id).toBe(userId);
      expect(row.name).toBe('fixing auth');
      expect(row.payload).toEqual({ cwd: '/x', branch: 'main' });
    });

    it('rejects without auth headers', async () => {
      const res = await app.request('/v1/save', {
        method: 'POST',
        body: JSON.stringify({ name: 'x' }),
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
      const body = '{"name":"x"}';
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
      const body = '{"name":"x"}';
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
      const res = await call('/v1/save', JSON.stringify({ name: '' }));
      expect(res.status).toBe(422);
    });

    it('422 on empty body', async () => {
      const res = await call('/v1/save', '');
      expect(res.status).toBe(422);
    });

    it('400 on invalid JSON body', async () => {
      const res = await call('/v1/save', '{not-json');
      expect(res.status).toBe(400);
    });
  });

  // ---------- /v1/list ----------

  describe('GET /v1/list', () => {
    it('returns the user\'s snapshots, newest first', async () => {
      await saveSnapshotImpl(db, userId, { name: 'oldest', payload: {} }, new Date('2026-05-24T09:00:00Z'));
      await saveSnapshotImpl(db, userId, { name: 'newest', payload: {} }, new Date('2026-05-24T09:01:00Z'));
      const res = await call('/v1/list', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { snapshots: Array<{ name: string }> };
      expect(json.snapshots.map((s) => s.name)).toEqual(['newest', 'oldest']);
    });

    it('honours ?limit=', async () => {
      for (let i = 0; i < 3; i++) {
        await saveSnapshotImpl(db, userId, { name: `n${i}`, payload: {} });
      }
      const res = await call('/v1/list?limit=2', '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { snapshots: unknown[] };
      expect(json.snapshots.length).toBe(2);
    });

    it('400 on a non-numeric limit', async () => {
      const res = await call('/v1/list?limit=banana', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });
  });

  // ---------- /v1/:id ----------

  describe('GET /v1/:id', () => {
    it('returns the snapshot for the owning user', async () => {
      const saved = await saveSnapshotImpl(db, userId, {
        name: 'x',
        payload: { cwd: '/x' },
      });
      const res = await call(`/v1/${saved.id}`, '', { method: 'GET' });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { id: number; payload: Record<string, unknown> };
      expect(json.id).toBe(saved.id);
      expect(json.payload).toEqual({ cwd: '/x' });
    });

    it('400 on a non-numeric id', async () => {
      const res = await call('/v1/banana', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('400 on an id of 0 (positive-only)', async () => {
      const res = await call('/v1/0', '', { method: 'GET' });
      expect(res.status).toBe(400);
    });

    it('404 when not owned by this api_client\'s user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
      const saved = await saveSnapshotImpl(db, other.id, { name: 'm', payload: {} });
      const res = await call(`/v1/${saved.id}`, '', { method: 'GET' });
      expect(res.status).toBe(404);
    });
  });

  // ---------- /v1/:id/restore ----------

  describe('POST /v1/:id/restore', () => {
    it('bumps restored_at + restored_count and returns the row', async () => {
      const saved = await saveSnapshotImpl(db, userId, { name: 'x', payload: { cwd: '/x' } });
      const res = await call(`/v1/${saved.id}/restore`, '');
      expect(res.status).toBe(200);
      const json = (await res.json()) as { restoredCount: number; restoredAt: string };
      expect(json.restoredCount).toBe(1);
      expect(json.restoredAt).toBeTruthy();
    });

    it('400 on a non-numeric id', async () => {
      const res = await call('/v1/banana/restore', '');
      expect(res.status).toBe(400);
    });

    it('404 when the snapshot is not owned by this user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
      const saved = await saveSnapshotImpl(db, other.id, { name: 'm', payload: {} });
      const res = await call(`/v1/${saved.id}/restore`, '');
      expect(res.status).toBe(404);
    });
  });

  // ---------- DELETE /v1/:id ----------

  describe('DELETE /v1/:id', () => {
    it('deletes the snapshot', async () => {
      const saved = await saveSnapshotImpl(db, userId, { name: 'x', payload: {} });
      const res = await call(`/v1/${saved.id}`, '', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const remaining = (await db.execute(
        sql`SELECT COUNT(*)::int AS c FROM context.snapshots WHERE id = ${saved.id}`,
      )) as unknown;
      const list = Array.isArray(remaining) ? remaining : (remaining as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { c: number }).c).toBe(0);
    });

    it('400 on a non-numeric id', async () => {
      const res = await call('/v1/banana', '', { method: 'DELETE' });
      expect(res.status).toBe(400);
    });

    it('404 when the snapshot does not belong to this user', async () => {
      const other = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
      const saved = await saveSnapshotImpl(db, other.id, { name: 'm', payload: {} });
      const res = await call(`/v1/${saved.id}`, '', { method: 'DELETE' });
      expect(res.status).toBe(404);
    });
  });
});
