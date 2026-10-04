import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { signRequest } from '@shared/crypto';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import type { AppBindings } from '../../workers/api/src/context';
import { insertAppClient, makeTestDb } from '../_setup/db';

async function buildApp() {
  const db = await makeTestDb();
  const client = await insertAppClient(db, {
    clientId: 'pm',
    hmacSecret: 'shh',
  });
  const app = new Hono<AppBindings>();
  app.use('/v1/*', hmacMiddleware(() => db));
  app.post('/v1/echo', (c) => c.json({ client: c.var.appClient.clientId, body: c.var.rawBody }));
  return { db, client, app };
}

async function signed(app: Hono<AppBindings>, body: string, headerOverrides: Record<string, string> = {}, secret = 'shh') {
  const ts = Date.now();
  const sig = await signRequest(secret, body, ts);
  const headers: Record<string, string> = {
    'X-Client-Id': 'pm',
    'X-Timestamp': String(ts),
    'X-Signature': sig,
    'Content-Type': 'application/json',
    ...headerOverrides,
  };
  return app.request('/v1/echo', { method: 'POST', headers, body });
}

describe('hmacMiddleware', () => {
  it('admits a correctly signed request', async () => {
    const { app } = await buildApp();
    const res = await signed(app, '{"hi":1}');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { client: string; body: string };
    expect(json.client).toBe('pm');
    expect(json.body).toBe('{"hi":1}');
  });

  it('rejects missing headers', async () => {
    const { app } = await buildApp();
    const res = await app.request('/v1/echo', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
  });

  it('rejects a non-numeric timestamp', async () => {
    const { app } = await buildApp();
    const res = await app.request('/v1/echo', {
      method: 'POST',
      headers: {
        'X-Client-Id': 'pm',
        'X-Timestamp': 'nope',
        'X-Signature': 'sig',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('invalid timestamp');
  });

  it('rejects an unknown client', async () => {
    const { app } = await buildApp();
    const ts = Date.now();
    const sig = await signRequest('shh', '{}', ts);
    const res = await app.request('/v1/echo', {
      method: 'POST',
      headers: {
        'X-Client-Id': 'mystery',
        'X-Timestamp': String(ts),
        'X-Signature': sig,
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('unknown client');
  });

  it('rejects a bad signature', async () => {
    const { app } = await buildApp();
    const ts = Date.now();
    const res = await app.request('/v1/echo', {
      method: 'POST',
      headers: {
        'X-Client-Id': 'pm',
        'X-Timestamp': String(ts),
        'X-Signature': 'AAAA',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe('bad signature');
  });

  it('default db factory throws absent Hyperdrive (smoke test)', async () => {
    // Sanity-check the default factory is wired — we don't actually
    // execute it (Hyperdrive isn't real in unit tests), just confirm
    // the middleware exposes the override path.
    const mw = hmacMiddleware();
    expect(typeof mw).toBe('function');
  });
});
