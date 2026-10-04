import { test } from 'vitest';
import assert from 'node:assert/strict';
import { publishEvents, prepareBatches, redactTelemetry, redactText, MAX_BATCH_BYTES } from '../src/collectors/publisher.js';
import tailWorker, { tailEvents } from '../src/collectors/tail.js';

const token = 'collector-test-token-'.repeat(3);
const ok = () => Response.json({ accepted: 1 }, { status: 202 });
const noWait = async () => {};

test('publisher retries transient failures with identical body and per-batch keys', async () => {
  const calls = [];
  let attempt = 0;
  const send = async (_url, init) => {
    calls.push(init);
    if (attempt++ === 0) throw new Error('connection reset after acceptance');
    if (attempt === 2) return new Response('', { status: 503 });
    return ok();
  };
  const receipt = await publishEvents({ url: 'https://observe.example', token, events: [{ message: 'hello' }], idempotencyKey: 'job-123', fetcher: send, sleep: noWait });
  assert.equal(receipt.events, 1);
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map(c => c.body)).size, 1);
  assert.equal(new Set(calls.map(c => c.headers['idempotency-key'])).size, 1);
  assert.equal(calls[0].redirect, 'manual');
});

test('publisher stable caller ID reproduces the same keys across restarts and chunks', async () => {
  const first = [], second = [];
  const options = { url: 'https://observe.example', token, events: Array.from({ length: 129 }, (_, i) => ({ message: String(i) })), idempotencyKey: 'persisted-export-id' };
  for (const keys of [first, second]) await publishEvents({ ...options, fetcher: async (_url, init) => { keys.push(init.headers['idempotency-key']); return ok(); } });
  assert.deepEqual(first, second);
  assert.equal(new Set(first).size, 2);
});

test('publisher does not retry permanent status including unsupported generic 500', async () => {
  for (const status of [301, 302, 307, 308, 400, 401, 403, 409, 413, 500]) {
    let count = 0;
    await assert.rejects(publishEvents({ url: 'https://observe.example', token, events: [{ message: 'test' }], fetcher: async () => { count++; return new Response('', { status }); }, sleep: noWait }), new RegExp(String(status)));
    assert.equal(count, 1);
  }
});

test('publisher honors bounded Retry-After and reports retry exhaustion', async () => {
  const waits = [];
  await assert.rejects(publishEvents({ url: 'https://observe.example', token, events: [{ message: 'test' }], attempts: 2, fetcher: async () => new Response('', { status: 429, headers: { 'retry-after': '3600' } }), sleep: async ms => waits.push(ms) }), /429/);
  assert.deepEqual(waits, [8000]);
});

test('publisher supports a Service Binding without public DNS or losing the binding receiver', async () => {
  const binding = { called: false, async fetch(_url, init) { this.called = true; assert.equal(init.headers.authorization, `Bearer ${token}`); return ok(); } };
  await publishEvents({ binding, token, events: [{ message: 'bound' }] });
  assert.equal(binding.called, true);
});

test('publisher splits by serialized UTF-8 bytes and count before sending anything', () => {
  const batches = prepareBatches(Array.from({ length: 129 }, () => ({ message: '한'.repeat(6000) })));
  assert.ok(batches.length > 2);
  assert.equal(batches.reduce((n, b) => n + b.events, 0), 129);
  for (const batch of batches) {
    assert.ok(new TextEncoder().encode(batch.body).length <= MAX_BATCH_BYTES);
    assert.ok(batch.events <= 128);
  }
});

test('publisher refuses oversized events, input, malformed options and unsafe destinations', async () => {
  const base = { url: 'https://observe.example', token, events: [{ message: 'test' }], fetcher: async () => assert.fail('must reject before network') };
  for (const change of [{ events: [] }, { events: [null] }, { token: 'short' }, { attempts: 0 }, { attempts: 9 }, { idempotencyKey: '' }, { url: 'http://example.com' }, { url: 'https://user:pass@example.com' }, { events: [{ message: 'x'.repeat(300000) }], sanitize: value => value }]) {
    await assert.rejects(publishEvents({ ...base, ...change }));
  }
  assert.throws(() => prepareBatches(Array.from({ length: 5001 }, () => ({}))), /events/);
  assert.throws(() => prepareBatches(Array.from({ length: 100 }, () => ({ message: 'x'.repeat(100000) })), value => value), /input/);
});

test('publisher allows loopback HTTP for local tests and fails on malformed receipts', async () => {
  await publishEvents({ url: 'http://127.0.0.1:8787', token, events: [{}], fetcher: async () => ok() });
  await assert.rejects(publishEvents({ url: 'https://observe.example', token, events: [{}], attempts: 1, fetcher: async () => new Response('not json', { status: 202 }) }));
});

test('sanitizer redacts credentials recursively without mutating source values', () => {
  const value = { message: 'Authorization: Bearer abcdefghijklmnop password=supersecret', headers: { cookie: 'session=oops' }, nested: [{ api_key: 'private', safe: 'visible' }], attributes: { 'http.request.header.authorization': 'private' } };
  const clean = redactTelemetry(value);
  assert.equal(clean.headers, '[REDACTED]');
  assert.equal(clean.nested[0].api_key, '[REDACTED]');
  assert.equal(clean.nested[0].safe, 'visible');
  assert.ok(!JSON.stringify(clean).includes('supersecret'));
  assert.ok(!JSON.stringify(clean).includes('private'));
  assert.equal(value.nested[0].api_key, 'private');
});

test('sanitizer bounds cycles, depth, arrays and removes URL queries', () => {
  const circular = { child: {} }; circular.child.parent = circular;
  assert.doesNotThrow(() => JSON.stringify(redactTelemetry(circular)));
  assert.match(JSON.stringify(redactTelemetry(circular)), /TRUNCATED/);
  const clean = redactTelemetry({ list: Array.from({ length: 101 }, () => 'ok') });
  assert.equal(clean.list.length, 101);
  assert.match(clean.list[100], /TRUNCATED/);
  assert.equal(redactText('see https://user:pass@example.com/path?token=private#fragment'), 'see https://example.com/path');
  assert.ok(!redactText('{"password":"private","safe":"visible"}').includes('private'));
  assert.ok(!redactText('Cookie: first=private; second=another-secret').includes('another-secret'));
});

test('Tail emits useful logs, exception messages and a summary with only allowed request fields', () => {
  const events = tailEvents([{ scriptName: 'real-worker', eventTimestamp: 1000, outcome: 'exception', event: { request: { url: 'https://user:secret@example.com/jobs?token=private', method: 'POST', headers: { authorization: 'private' }, cf: { country: 'KR' }, body: 'patient-data' }, response: { status: 500 } }, logs: [{ timestamp: 1001, level: 'info', message: ['task started', { password: 'private', task_id: '123' }] }], exceptions: [{ timestamp: 1002, name: 'Error', message: 'operation failed token=private', stack: 'patient-data' }] }]);
  assert.equal(events.length, 3);
  assert.equal(events[0].service, 'real-worker');
  assert.equal(events[0].attributes['http.path'], '/jobs');
  assert.equal(events[0].attributes['http.method'], 'POST');
  assert.equal(events[0].attributes['http.status_code'], 500);
  assert.match(events[1].message, /task started/);
  assert.match(events[2].message, /operation failed/);
  assert.ok(!JSON.stringify(events).includes('private'));
  assert.ok(!JSON.stringify(events).includes('patient-data'));
  assert.ok(!JSON.stringify(events).includes('country'));
});

test('Tail excludes itself and receiver, handles non-HTTP triggers and omits unknown producers', () => {
  const events = tailEvents([{ scriptName: 'cf-observe', logs: [] }, { scriptName: 'cf-observe-tail', logs: [] }, { scriptName: '', logs: [] }, { scriptName: 'cron-worker', eventTimestamp: 1000, event: null, outcome: 'ok', logs: [], exceptions: [] }]);
  assert.equal(events.length, 1);
  assert.equal(events[0].service, 'cron-worker');
  assert.equal(events[0].attributes['http.path'], undefined);
});

test('Tail bounded truncation emits visible counts and does not mutate caller entries', () => {
  const item = { scriptName: 'busy', eventTimestamp: 1000, logs: Array.from({ length: 130 }, () => ({ level: 'log', message: ['hello'] })), exceptions: [] };
  const events = tailEvents([item]);
  assert.equal(events.length, 129);
  assert.equal(events[0].attributes['cf.tail.omitted_logs'], 2);
  assert.equal(item.logs.length, 130);
});

test('Tail registers async delivery with waitUntil and stays silent for excluded invocations', async () => {
  const work = [], calls = [];
  const env = { INGEST_TOKEN: token, OBSERVE: { fetch: async (url, init) => { calls.push({ url, init }); return ok(); } } };
  const ctx = { waitUntil(promise) { work.push(promise); } };
  tailWorker.tail([{ scriptName: 'producer', eventTimestamp: Date.now(), logs: [], exceptions: [], outcome: 'ok' }], env, ctx);
  assert.equal(work.length, 1);
  await Promise.all(work);
  assert.equal(calls.length, 1);
  tailWorker.tail([{ scriptName: 'cf-observe' }], env, ctx);
  assert.equal(work.length, 1);
});

test('Tail separates many producer exports rather than exceeding publisher input limits', async () => {
  const work = [], sizes = [];
  const items = Array.from({ length: 40 }, (_, i) => ({ scriptName: `producer-${i}`, eventTimestamp: Date.now(), outcome: 'ok', logs: Array.from({ length: 128 }, () => ({ message: ['log'] })) }));
  tailWorker.tail(items, { INGEST_TOKEN: token, OBSERVE: { async fetch(_url, init) { sizes.push(JSON.parse(init.body).length); return ok(); } } }, { waitUntil(p) { work.push(p); } });
  await Promise.all(work);
  assert.equal(sizes.reduce((sum, count) => sum + count, 0), 40 * 129);
  assert.ok(sizes.every(size => size <= 128));
});

test('Tail reports long-message truncation, exception limits and path credential redaction', () => {
  const rows = tailEvents([{ scriptName: 'producer', logs: [{ message: ['x'.repeat(9000)] }], event: { request: { url: 'https://example.com/token/private', method: 'GET' } }, exceptions: Array.from({ length: 17 }, () => ({ message: 'error' })) }]);
  assert.equal(rows.length, 18);
  assert.equal(rows[0].attributes['cf.tail.omitted_exceptions'], 1);
  assert.equal(rows[0].attributes['http.path'], '/token/[REDACTED]');
  assert.match(rows[1].message, /TRUNCATED/);
  assert.throws(() => tailEvents({}), /array/);
});
