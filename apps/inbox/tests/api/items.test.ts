import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { itemsRouter } from '../../workers/api/src/handlers/items';
import { captureImpl } from '~/server/inbox';
import { signRequest } from '~/lib/hmac';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('/v1/items (HMAC)', () => {
  let db: TestDB;
  let aliceUserId: number;
  let aliceSecret: string;
  let aliceItemIds: { unread1: number; unread2: number; done: number; pinned: number };
  let mallorySecret: string;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    db = await makeTestDb();
    const alice = await insertPmUser(db, { login: 'alice' });
    aliceUserId = alice.id;
    aliceSecret = 'unit-test-secret-32-bytes-long-aaa';
    await db.execute(sql`
      INSERT INTO inbox.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${aliceSecret}, ${aliceUserId})
    `);

    // Mallory has her own CLI client + user; we use her to prove that a
    // forged item id can't mutate alice's rows.
    const mallory = await insertPmUser(db, { login: 'mallory', sub: 'sso-mallory' });
    mallorySecret = 'unit-test-secret-32-bytes-long-bbb';
    await db.execute(sql`
      INSERT INTO inbox.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli-mallory', 'CLI Mallory', ${mallorySecret}, ${mallory.id})
    `);

    // Seed alice's inbox: 2 unread, 1 done, 1 pinned.
    const u1 = await captureImpl(db, aliceUserId, { text: 'unread one', source: 'cli' });
    const u2 = await captureImpl(db, aliceUserId, { text: 'unread two', source: 'cli' });
    const d = await captureImpl(db, aliceUserId, { text: 'finished thing', source: 'cli' });
    const p = await captureImpl(db, aliceUserId, { text: 'starred thing', source: 'cli' });
    await db.execute(sql`UPDATE inbox.items SET status = 'done'   WHERE id = ${d.id}`);
    await db.execute(sql`UPDATE inbox.items SET status = 'pinned' WHERE id = ${p.id}`);
    aliceItemIds = { unread1: u1.id, unread2: u2.id, done: d.id, pinned: p.id };

    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1/items', itemsRouter);
  });

  async function sign(secret: string, body: string): Promise<{ ts: number; sig: string }> {
    const ts = Date.now();
    const sig = await signRequest(secret, body, ts);
    return { ts, sig };
  }

  // ---------- GET /v1/items ----------

  describe('GET /v1/items', () => {
    it('returns unread items by default', async () => {
      const { ts, sig } = await sign(aliceSecret, '');
      const res = await app.request('/v1/items', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        items: Array<{ id: number; text: string; status: string; capturedAt: string }>;
      };
      expect(json.items).toHaveLength(2);
      const texts = json.items.map((i) => i.text).sort();
      expect(texts).toEqual(['unread one', 'unread two']);
      for (const item of json.items) {
        expect(item.status).toBe('unread');
        expect(typeof item.capturedAt).toBe('string');
      }
    });

    it('filters by ?status=done', async () => {
      const { ts, sig } = await sign(aliceSecret, '');
      const res = await app.request('/v1/items?status=done', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { items: Array<{ id: number; status: string }> };
      expect(json.items).toHaveLength(1);
      expect(json.items[0]!.status).toBe('done');
      expect(json.items[0]!.id).toBe(aliceItemIds.done);
    });

    it('filters by ?status=snoozed and stringifies snoozedUntil', async () => {
      // Snooze unread1 with an explicit wake time.
      const wake = new Date('2027-01-01T00:00:00.000Z');
      await db.execute(sql`
        UPDATE inbox.items
        SET status = 'snoozed', snoozed_until = ${wake}
        WHERE id = ${aliceItemIds.unread1}
      `);
      const { ts, sig } = await sign(aliceSecret, '');
      const res = await app.request('/v1/items?status=snoozed', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        items: Array<{ id: number; status: string; snoozedUntil: string | null }>;
      };
      expect(json.items).toHaveLength(1);
      expect(json.items[0]!.status).toBe('snoozed');
      expect(json.items[0]!.snoozedUntil).not.toBeNull();
      // Different drivers serialise the offset differently
      // (`+00:00` vs `Z`); compare as instants to be driver-agnostic.
      expect(Date.parse(json.items[0]!.snoozedUntil!)).toBe(wake.getTime());
    });

    it('filters by ?status=pinned', async () => {
      const { ts, sig } = await sign(aliceSecret, '');
      const res = await app.request('/v1/items?status=pinned', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { items: Array<{ id: number; status: string }> };
      expect(json.items).toHaveLength(1);
      expect(json.items[0]!.status).toBe('pinned');
    });

    it('?status=all returns everything except dropped', async () => {
      // Mark unread2 as dropped to make the assertion specific.
      await db.execute(sql`UPDATE inbox.items SET status = 'dropped' WHERE id = ${aliceItemIds.unread2}`);
      const { ts, sig } = await sign(aliceSecret, '');
      const res = await app.request('/v1/items?status=all', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { items: Array<{ id: number; status: string }> };
      // unread1 + done + pinned = 3 (unread2 was just dropped).
      expect(json.items).toHaveLength(3);
      for (const item of json.items) {
        expect(item.status).not.toBe('dropped');
      }
    });

    it('honours a custom ?limit', async () => {
      const { ts, sig } = await sign(aliceSecret, '');
      const res = await app.request('/v1/items?status=all&limit=2', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { items: unknown[] };
      expect(json.items).toHaveLength(2);
    });

    it('400 on an invalid ?status value', async () => {
      const { ts, sig } = await sign(aliceSecret, '');
      const res = await app.request('/v1/items?status=nope', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(400);
    });

    it('400 on an invalid ?limit value', async () => {
      const { ts, sig } = await sign(aliceSecret, '');
      const res = await app.request('/v1/items?limit=999999', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(400);
    });

    it('does not leak the other client_id\'s items', async () => {
      // Mallory's inbox is empty; she should get [].
      const { ts, sig } = await sign(mallorySecret, '');
      const res = await app.request('/v1/items', {
        method: 'GET',
        headers: {
          'X-Client-Id': 'cli-mallory',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { items: unknown[] };
      expect(json.items).toEqual([]);
    });

    it('rejects unsigned GETs', async () => {
      const res = await app.request('/v1/items', { method: 'GET' });
      expect(res.status).toBe(401);
    });
  });

  // ---------- PATCH /v1/items/:id ----------

  describe('PATCH /v1/items/:id', () => {
    it('transitions via {action: "done"} (CLI shape)', async () => {
      const body = JSON.stringify({ action: 'done' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { id: number; status: string };
      expect(json.id).toBe(aliceItemIds.unread1);
      expect(json.status).toBe('done');

      // Round-trip via DB.
      const rows = (await db.execute(
        sql`SELECT status FROM inbox.items WHERE id = ${aliceItemIds.unread1}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { status: string }).status).toBe('done');
    });

    it('transitions via {action: "drop"}', async () => {
      const body = JSON.stringify({ action: 'drop' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { id: number; status: string };
      expect(json.status).toBe('dropped');
    });

    it('transitions via {status: "pinned"} (status shape)', async () => {
      const body = JSON.stringify({ status: 'pinned' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { id: number; status: string; snoozedUntil: string | null };
      expect(json.status).toBe('pinned');
      expect(json.snoozedUntil).toBeNull();
    });

    it('transitions via {status: "dropped"}', async () => {
      const body = JSON.stringify({ status: 'dropped' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string };
      expect(json.status).toBe('dropped');
    });

    it('transitions via {status: "snoozed", snoozedUntil}', async () => {
      const wake = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
      const body = JSON.stringify({ status: 'snoozed', snoozedUntil: wake.toISOString() });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { status: string; snoozedUntil: string | null };
      expect(json.status).toBe('snoozed');
      expect(json.snoozedUntil).toBe(wake.toISOString());
    });

    it('snooze without explicit snoozedUntil defaults to 1d out', async () => {
      const before = Date.now();
      const body = JSON.stringify({ status: 'snoozed' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { snoozedUntil: string | null };
      expect(json.snoozedUntil).not.toBeNull();
      const delta = Date.parse(json.snoozedUntil!) - before;
      // ≈ 1 day (allow generous slop for CI).
      expect(delta).toBeGreaterThan(23 * 60 * 60 * 1000);
      expect(delta).toBeLessThan(25 * 60 * 60 * 1000);
    });

    it('403 when patching someone else\'s item (action shape)', async () => {
      // Mallory tries to patch alice's unread1.
      const body = JSON.stringify({ action: 'done' });
      const { ts, sig } = await sign(mallorySecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli-mallory',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(403);
      // alice's row must be unchanged.
      const rows = (await db.execute(
        sql`SELECT status FROM inbox.items WHERE id = ${aliceItemIds.unread1}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { status: string }).status).toBe('unread');
    });

    it('403 when patching someone else\'s item (status shape)', async () => {
      const body = JSON.stringify({ status: 'pinned' });
      const { ts, sig } = await sign(mallorySecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli-mallory',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(403);
      // alice's row must still be untouched.
      const rows = (await db.execute(
        sql`SELECT status FROM inbox.items WHERE id = ${aliceItemIds.unread1}`,
      )) as unknown;
      const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
      expect((list[0] as { status: string }).status).toBe('unread');
    });

    it('403 on a non-existent item id', async () => {
      const body = JSON.stringify({ action: 'done' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request('/v1/items/999999', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(403);
    });

    it('400 on an invalid action', async () => {
      const body = JSON.stringify({ action: 'eat' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('400 on an invalid status', async () => {
      const body = JSON.stringify({ status: 'cooked' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('400 on a non-numeric :id', async () => {
      const body = JSON.stringify({ action: 'done' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request('/v1/items/abc', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('400 on a non-positive :id', async () => {
      const body = JSON.stringify({ action: 'done' });
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request('/v1/items/0', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('400 on invalid JSON', async () => {
      const body = '{not-json';
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(400);
    });

    it('400 on empty body (no action / no status)', async () => {
      const body = '';
      const { ts, sig } = await sign(aliceSecret, body);
      const res = await app.request(`/v1/items/${aliceItemIds.unread1}`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      });
      expect(res.status).toBe(400);
    });
  });
});
