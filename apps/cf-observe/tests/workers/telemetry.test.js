import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { encodeFixture } from '../protobuf-fixtures.js';

const origin = 'https://observe.test';
const journal = () => env.JOURNAL.get(env.JOURNAL.idFromName(env.DATASET));
const request = (path, token = env.VIEWER_TOKEN, init = {}) => exports.default.fetch(origin + path, {
  ...init,
  headers: { authorization: `Bearer ${token}`, ...init.headers },
});
const ingest = (message) => request('/api/ingest', env.INGEST_TOKEN, {
  method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': message },
  body: JSON.stringify([{ service: 'runtime-test', message, attributes: { preserved: true } }]),
});
async function query(message) {
  const response = await request('/api/events?' + new URLSearchParams({
    from: String(Date.now() - 60000), to: String(Date.now() + 60000), q: message,
  }));
  expect(response.status).toBe(200);
  return (await response.json()).events;
}
function nextMessage(ws, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { ws.removeEventListener('message', listener); reject(new Error('WebSocket message timed out')); }, 5000);
    function listener(event) {
      const value = JSON.parse(event.data);
      if (predicate(value)) {
        clearTimeout(timeout);
        ws.removeEventListener('message', listener);
        resolve(value);
      }
    }
    ws.addEventListener('message', listener);
  });
}

test('accepted data survives object eviction, then archives through a real R2 binding', async () => {
  const marker = crypto.randomUUID();
  const accepted = await ingest(marker);
  expect(accepted.status).toBe(202);
  const receipt = await accepted.json();
  const [buffered] = await query(marker);
  expect(buffered.storage).toBe('buffer');
  await evictDurableObject(journal());
  expect((await query(marker))[0].id).toBe(buffered.id);
  expect(await runDurableObjectAlarm(journal())).toBe(true);
  const [archived] = await query(marker);
  expect(archived.storage).toBe('r2');
  expect(archived.id).toBe(buffered.id);
  const detail = await request('/api/event?' + new URLSearchParams({
    id: archived.id, seq: String(archived.seq), receivedAt: String(archived.receivedAt),
  }));
  expect((await detail.json()).event.raw.attributes).toEqual({ preserved: true });
  expect((await (await ingest(marker)).json()).batchId).toBe(receipt.batchId);
  expect(await query(marker)).toHaveLength(1);
  const objects = await env.ARCHIVE.list();
  expect(objects.objects.some(o => o.key.endsWith('.ndjson.gz'))).toBe(true);
  expect(objects.objects.some(o => o.key.startsWith('index/'))).toBe(true);
});

test('hibernated WebSockets retain filters and receive only durable accepted previews', async () => {
  const marker = crypto.randomUUID();
  const response = await request('/api/live?' + new URLSearchParams({ q: marker }), env.VIEWER_TOKEN, {
    headers: { upgrade: 'websocket', origin },
  });
  expect(response.status).toBe(101);
  const ws = response.webSocket;
  ws.accept();
  try {
    await evictDurableObject(journal());
    const frame = nextMessage(ws, value => value.type === 'events');
    expect((await ingest(marker)).status).toBe(202);
    const received = await frame;
    expect(received.events).toHaveLength(1);
    expect(received.events[0].message).toBe(marker);
    expect(received.events[0]).not.toHaveProperty('raw');
    expect((await query(marker))[0].id).toBe(received.events[0].id);
    const attachments = await runInDurableObject(journal(), (_instance, state) =>
      state.getWebSockets().map(socket => socket.deserializeAttachment()));
    expect(attachments[0].filters.q).toBe(marker);
  } finally {
    ws.close(1000, 'Test complete');
  }
});

test('real Worker session cookies enforce origin and separate read/write privileges', async () => {
  expect((await request('/api/health', '')).status).toBe(401);
  expect((await request('/api/ingest', env.VIEWER_TOKEN, { method: 'POST' })).status).toBe(401);
  expect((await request('/api/health', env.INGEST_TOKEN)).status).toBe(401);
  const login = await exports.default.fetch(origin + '/api/session', {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ token: env.VIEWER_TOKEN }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie');
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect((await exports.default.fetch(origin + '/api/health', { headers: { cookie } })).status).toBe(200);
  expect((await request('/api/live', env.VIEWER_TOKEN, {
    headers: { origin: 'https://untrusted.test', upgrade: 'websocket' },
  })).status).toBe(403);
});

test('OTLP JSON and compressed protobuf succeed and retain policy-filtered decoded payloads', async () => {
  for (const signal of ['logs', 'traces', 'metrics']) {
    const response = await request('/v1/' + signal, env.INGEST_TOKEN, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
  }
  const wire = encodeFixture('logs', BigInt(Date.now()) * 1000000n);
  const compressed = await new Response(new Blob([wire]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const response = await request('/v1/logs', env.INGEST_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip' },
    body: compressed,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('application/x-protobuf');
  expect((await response.arrayBuffer()).byteLength).toBe(0);
  const [event] = await query('binary log');
  const batch = await (await journal().fetch('https://journal/batch?seq=' + event.seq)).json();
  expect(batch).not.toHaveProperty('wireBase64');
  expect(batch.rawWireOmitted).toBe(true);
  expect(JSON.stringify(batch.payload)).toContain('binary log');
});
