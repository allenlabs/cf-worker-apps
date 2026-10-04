import { env, exports } from 'cloudflare:workers';
import { evictDurableObject, runDurableObjectAlarm } from 'cloudflare:test';
import { expect, test } from 'vitest';
import { concat, message, string } from '../protobuf-fixtures.js';

const origin = 'https://observe.test';
const journal = () => env.JOURNAL.get(env.JOURNAL.idFromName(env.DATASET));
const request = (path, token = env.VIEWER_TOKEN, init = {}) => exports.default.fetch(origin + path, {
  ...init, headers: { authorization: `Bearer ${token}`, ...init.headers },
});

test('redacted OTLP persists safe source attribution and cumulative source stats through eviction and archive', async () => {
  const marker = crypto.randomUUID();
  const credential = 'credential-' + crypto.randomUUID();
  const attr = concat(string(1, 'api.key'), message(2, string(1, credential)));
  const wire = message(1, message(2, message(2, concat(message(5, string(1, marker)), message(6, attr)))));
  const send = () => request('/v1/logs', env.INGEST_TOKEN, {
    method: 'POST', headers: { 'content-type': 'application/x-protobuf', 'idempotency-key': marker }, body: wire,
  });
  const first = await send();
  expect(first.status).toBe(200);
  const batchId = first.headers.get('x-cf-observe-batch-id');
  await evictDurableObject(journal());
  expect((await send()).headers.get('x-cf-observe-batch-id')).toBe(batchId);
  const query = await request('/api/events?' + new URLSearchParams({ from: String(Date.now() - 60000), to: String(Date.now() + 60000), q: marker }));
  const [event] = (await query.json()).events;
  expect(event.sourceId).toBe('legacy');
  const health = await (await request('/api/health')).json();
  expect(health.sources.find(source => source.sourceId === 'legacy').acceptedBatches).toBeGreaterThanOrEqual(1);
  expect(health.maxPendingBatches).toBe(256);
  expect(health.maxPendingBytes).toBe(16777216);
  await runDurableObjectAlarm(journal());
  const detail = await request('/api/event?' + new URLSearchParams({ id: event.id, seq: String(event.seq), receivedAt: String(event.receivedAt) }));
  const body = await detail.json();
  expect(body.storage).toBe('r2');
  expect(body.batch.sourceId).toBe('legacy');
  expect(body.batch.rawWireOmitted).toBe(true);
  expect(body.batch).not.toHaveProperty('wireBase64');
  expect(JSON.stringify(body)).not.toContain(credential);
  expect((await send()).headers.get('x-cf-observe-batch-id')).toBe(batchId);
});

test('real OTLP malformed protobuf and denied credentials receive wire-encoded error Status', async () => {
  for (const [token, body, status] of [[env.INGEST_TOKEN, new Uint8Array([0]), 400], ['wrong', new Uint8Array(), 401]]) {
    const response = await request('/v1/logs', token, { method: 'POST', headers: { 'content-type': 'application/x-protobuf' }, body });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-type')).toBe('application/x-protobuf');
    const wire = new Uint8Array(await response.arrayBuffer());
    expect(wire[0]).toBe(18);
    expect(wire[1]).toBe(wire.length - 2);
    expect(response.headers.get('retry-after')).toBeNull();
  }
});
