import { describe, expect, it, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { captureRouter } from '../../workers/api/src/handlers/capture';
import { signRequest } from '~/lib/hmac';
import { makeTestDb, insertPmUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('POST /v1/capture (HMAC)', () => {
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
      INSERT INTO inbox.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${userId})
    `);

    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1/capture', captureRouter);
  });

  async function sign(body: string): Promise<{ ts: number; sig: string }> {
    const ts = Date.now();
    const sig = await signRequest(secret, body, ts);
    return { ts, sig };
  }

  it('captures with valid HMAC', async () => {
    const body = JSON.stringify({ text: 'first idea', tags: ['x'] });
    const { ts, sig } = await sign(body);
    const res = await app.request(
      '/v1/capture',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Client-Id': 'cli',
          'X-Timestamp': String(ts),
          'X-Signature': sig,
        },
        body,
      },
      { HYPERDRIVE: {} } as unknown as Record<string, unknown>,
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { id: number };
    expect(typeof json.id).toBe('number');
    const rows = (await db.execute(
      sql`SELECT user_id, text, source, tags FROM inbox.items WHERE id = ${json.id}`,
    )) as unknown;
    const list = Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [];
    const row = list[0] as { user_id: number; text: string; source: string; tags: string[] };
    expect(row.user_id).toBe(userId);
    expect(row.text).toBe('first idea');
    // Source defaults to the client_id when caller omits one.
    expect(row.source).toBe('cli');
    expect(row.tags).toEqual(['x']);
  });

  it('rejects without auth headers', async () => {
    const res = await app.request('/v1/capture', {
      method: 'POST',
      body: JSON.stringify({ text: 'x' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects with an invalid timestamp', async () => {
    const res = await app.request('/v1/capture', {
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
    const body = '{"text":"x"}';
    const { ts, sig } = await sign(body);
    const res = await app.request('/v1/capture', {
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
    const body = '{"text":"x"}';
    const ts = Date.now();
    const res = await app.request('/v1/capture', {
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
    const body = JSON.stringify({ text: '' });
    const { ts, sig } = await sign(body);
    const res = await app.request('/v1/capture', {
      method: 'POST',
      headers: {
        'X-Client-Id': 'cli',
        'X-Timestamp': String(ts),
        'X-Signature': sig,
      },
      body,
    });
    expect(res.status).toBe(422);
  });

  it('422 on empty body (no text)', async () => {
    const body = '';
    const { ts, sig } = await sign(body);
    const res = await app.request('/v1/capture', {
      method: 'POST',
      headers: {
        'X-Client-Id': 'cli',
        'X-Timestamp': String(ts),
        'X-Signature': sig,
      },
      body,
    });
    expect(res.status).toBe(422);
  });

  it('400 on invalid JSON body', async () => {
    const body = '{not-json';
    const { ts, sig } = await sign(body);
    const res = await app.request('/v1/capture', {
      method: 'POST',
      headers: {
        'X-Client-Id': 'cli',
        'X-Timestamp': String(ts),
        'X-Signature': sig,
      },
      body,
    });
    expect(res.status).toBe(400);
  });
});
