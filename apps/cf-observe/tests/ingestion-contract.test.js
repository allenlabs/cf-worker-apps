import { test } from 'vitest';
import assert from 'node:assert/strict';
import worker from '../src/worker.js';
import { TelemetryJournal } from '../src/journal.js';
import { makeContext, makeEnv, attachNamespace, makeBatch } from './helpers.js';
import { concat, message, string } from './protobuf-fixtures.js';
import { gunzip, sha256 } from '../src/util.js';
import { applyIngestPolicy } from '../src/ingest-policy.js';
import { decodeBody } from '../src/protocol.js';

const sourceToken = 'source-a-'.repeat(8), otherToken = 'source-b-'.repeat(8);
function setup(extra = {}) {
  const env = makeEnv(extra), ctx = makeContext(), journal = new TelemetryJournal(ctx, env);
  attachNamespace(env, journal);
  return { env, ctx, journal };
}
const ingest = (env, payload, token = env.INGEST_TOKEN, key = '', path = '/api/ingest', type = 'application/json') => worker.fetch(new Request('https://observe.test' + path, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': type, 'idempotency-key': key },
  body: type === 'application/x-protobuf' ? payload : JSON.stringify(payload),
}), env);
const sources = (a = { token: sourceToken }) => JSON.stringify({ alpha: a, beta: { token: otherToken } });

test('trusted source identity scopes receipts and survives token rotation without counting retries', async () => {
  const { env, journal } = setup({ SOURCE_TOKENS: sources() });
  const body = [{ sourceId: 'forged', message: 'same payload' }];
  const first = await ingest(env, body, sourceToken, 'batch-1');
  assert.equal(first.status, 202);
  const a = await first.json();
  const b = await (await ingest(env, body, otherToken, 'batch-1')).json();
  assert.notEqual(a.batchId, b.batchId);
  assert.equal(journal.batch(a.seq).sourceId, 'alpha');
  assert.equal((await ingest(env, [{ message: 'different' }], sourceToken, 'batch-1')).status, 409);
  const rotated = 'rotated-source-'.repeat(4);
  env.SOURCE_TOKENS = sources({ token: rotated });
  const duplicate = await (await ingest(env, body, rotated, 'batch-1')).json();
  assert.equal(duplicate.batchId, a.batchId);
  assert.equal(duplicate.duplicate, true);
  assert.equal((await ingest(env, body, sourceToken)).status, 401);
  const stats = journal.health().sources;
  assert.equal(stats.find(s => s.sourceId === 'alpha').acceptedBatches, 1);
  assert.equal(stats.find(s => s.sourceId === 'alpha').acceptedEvents, 1);
  assert.ok(stats.find(s => s.sourceId === 'alpha').acceptedBytes > 0);
  await journal.alarm();
  assert.equal(new TelemetryJournal(journal.ctx, env).health().sources.length, 2);
});

test('disabled, invalid, overlapping and oversized source registries fail closed', async () => {
  for (const config of [sources({ token: sourceToken, enabled: false }), JSON.stringify({ alpha: { token: sourceToken }, beta: { token: sourceToken } }), '{bad', JSON.stringify({ alpha: { token: 'short' } }), JSON.stringify({ alpha: { token: 'v'.repeat(48) } }), JSON.stringify({ legacy: { token: sourceToken } }), JSON.stringify(Object.fromEntries(Array.from({ length: 65 }, (_, i) => ['s' + i, { token: String(i).padEnd(48, 'x') }])) )]) {
    const { env, journal } = setup({ SOURCE_TOKENS: config });
    const response = await ingest(env, {}, sourceToken);
    assert.ok([401, 503].includes(response.status), `unexpected status ${response.status}`);
    assert.equal(journal.health().pendingBatches, 0);
  }
});

test('source-only configuration works without a legacy ingest token and never grants viewer access', async () => {
  const { env, journal } = setup({ SOURCE_TOKENS: sources(), INGEST_TOKEN: undefined });
  assert.equal((await ingest(env, [{ message: 'hello' }], sourceToken)).status, 202);
  assert.equal(journal.health().sources[0].sourceId, 'alpha');
  const denied = await worker.fetch(new Request('https://observe.test/api/health', { headers: { authorization: `Bearer ${sourceToken}` } }), env);
  assert.equal(denied.status, 401);
});

test('raw JSON secrets and OTLP attribute secrets are filtered before journal and R2 persistence', async () => {
  const { env, journal } = setup();
  const marker = 'sensitive-needle-123';
  const payload = [{ message: `GET https://example.test/a?token=${marker}&page=2 Bearer ${marker}`, password: marker, request: { headers: { Authorization: marker, cookie: marker }, api_key: marker }, attributes: [{ key: 'http.request.header.authorization', value: { stringValue: marker } }, { key: 'safe', value: { stringValue: 'kept' } }] }];
  const response = await ingest(env, payload);
  assert.equal(response.status, 202);
  const receipt = await response.json(), batch = journal.batch(receipt.seq);
  assert.ok(!JSON.stringify(batch).includes(marker));
  assert.ok(JSON.stringify(batch).includes('kept'));
  assert.equal(batch.redacted, true);
  await journal.alarm();
  const archived = [...env.ARCHIVE.objects.entries()].find(([key]) => key.endsWith('.gz'))[1];
  assert.ok(!new TextDecoder().decode(await gunzip(archived.bytes)).includes(marker));
});

test('protobuf redaction omits original wire and filtered raw retains safe attributes', async () => {
  const { env, journal } = setup();
  const secret = 'protobuf-secret-marker';
  const kv = concat(string(1, 'authorization'), message(2, string(1, secret)));
  const log = concat(message(5, string(1, 'safe log')), message(6, kv));
  const wire = message(1, message(2, message(2, log)));
  const response = await ingest(env, wire, env.INGEST_TOKEN, '', '/v1/logs', 'application/x-protobuf');
  assert.equal(response.status, 200);
  const batch = journal.batch(1);
  assert.equal(batch.rawWireOmitted, true);
  assert.equal(batch.redacted, true);
  assert.equal(batch.wireBase64, undefined);
  assert.ok(!JSON.stringify(batch).includes(secret));
  assert.ok(JSON.stringify(batch).includes('safe log'));
});

test('unknown protobuf fields cannot bypass stored-payload filtering via original wire', async () => {
  const { env, journal } = setup();
  const secret = 'unknown-field-secret';
  const wire = concat(message(1, message(2, message(2, message(5, string(1, 'known safe field'))))), string(99, secret));
  assert.equal((await ingest(env, wire, env.INGEST_TOKEN, '', '/v1/logs', 'application/x-protobuf')).status, 200);
  const batch = journal.batch(1);
  assert.equal(batch.rawWireOmitted, true);
  assert.equal(batch.wireBase64, undefined);
  assert.equal(batch.redacted, false);
  assert.ok(!JSON.stringify(batch).includes(secret));
});

test('text filtering strips URL credentials and recognizable unlabelled provider keys or JWTs', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiZXhhbXBsZSJ9.YWJjZGVmZ2hpamtsbW5vcA';
  const github = 'ghp_abcdefghijklmnopqrstuvwx1234567890';
  const apiKey = 'sk-abcdefghijklmnopqrstuvwx1234567890';
  const body = `see https://alice:actual-password@example.com/path?page=2 ${jwt} ${github} ${apiKey}`;
  const clean = applyIngestPolicy({ payload: [{ message: body }], encoding: 'json' });
  const stored = JSON.stringify(clean);
  for (const credential of ['actual-password', 'alice:', jwt, github, apiKey]) assert.ok(!stored.includes(credential));
  assert.ok(stored.includes('example.com/path?page=2'));
  assert.equal(clean.redacted, true);
});

test('OTLP storage failure is retryable with correctly encoded Status and no live success', async () => {
  for (const type of ['application/json', 'application/x-protobuf']) {
    const { env, ctx } = setup();
    const sent = [];
    ctx.acceptWebSocket({ deserializeAttachment: () => ({ exp: Date.now() + 10000 }), send: s => sent.push(s), close() {} });
    ctx.storage.sync = async () => { throw new Error('private storage failure'); };
    const response = await ingest(env, type === 'application/json' ? {} : new Uint8Array(), env.INGEST_TOKEN, '', '/v1/logs', type);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '10');
    assert.ok(response.headers.get('content-type').startsWith(type));
    if (type === 'application/json') {
      const body = await response.json();
      assert.equal(typeof body.message, 'string');
      assert.equal(body.error, undefined);
    } else {
      const bytes = new Uint8Array(await response.arrayBuffer());
      assert.equal(bytes[0], 18); // google.rpc.Status.message, independently checked wire tag.
      assert.equal(bytes[1], bytes.length - 2);
    }
    assert.equal(sent.length, 0);
  }
});

test('DO transport failures are 503 while malformed OTLP and authorization failures remain permanent', async () => {
  const { env } = setup();
  env.JOURNAL.get = () => ({ fetch: async () => { throw new Error('unavailable'); } });
  const failed = await ingest(env, {});
  assert.equal(failed.status, 503);
  assert.equal((await ingest(env, { resourceLogs: 'bad' }, env.INGEST_TOKEN, '', '/v1/logs')).status, 400);
  const unauthorized = await ingest(env, new Uint8Array(), 'wrong', '', '/v1/logs', 'application/x-protobuf');
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get('content-type'), 'application/x-protobuf');
});

test('pending pressure schedules early flush and reports both configured capacity limits', async () => {
  const { env, ctx, journal } = setup({ MAX_PENDING_BYTES: '8192' });
  await journal.ingest(makeBatch(1, Date.now(), { payload: [{ message: 'a'.repeat(6200) }] }));
  assert.ok(await ctx.storage.getAlarm() < Date.now() + 1000);
  assert.equal(journal.health().maxPendingBytes, 8192);
  assert.equal(journal.health().maxPendingBatches, 256);
  assert.ok(journal.health().pendingUtilization > 0.75);
  for (let i = 0; i < 3; i++) {
    env.ARCHIVE.fail = () => true;
    ctx._fire();
    await journal.alarm();
  }
  const retryAt = await ctx.storage.getAlarm();
  await journal.ingest(makeBatch());
  await journal.fetch(new Request('https://journal/kick'));
  assert.equal(await ctx.storage.getAlarm(), retryAt);
  assert.equal(journal.health().nextRetryAt, retryAt);
});

test('receipt retention supports configured seven days and defaults to the existing one day', async () => {
  for (const days of [undefined, '7']) {
    const { journal } = setup({ RECEIPT_RETENTION_DAYS: days });
    const now = Date.now();
    await journal.ingest(makeBatch(), 'kept');
    const row = journal.rows('SELECT expires_at FROM receipts')[0];
    assert.ok(Math.abs(row.expires_at - now - Number(days ?? 1) * 86400000) < 1000);
  }
});

test('legacy receipts created before source credentials remain valid after an upgrade', async () => {
  const { journal } = setup();
  const batch = makeBatch();
  await journal.ingest(batch, 'pre-upgrade');
  journal.sql.exec('UPDATE receipts SET key = ?', await sha256('pre-upgrade'));
  const retry = await journal.ingest({ ...batch, id: crypto.randomUUID() }, 'pre-upgrade');
  assert.equal(retry.duplicate, true);
  assert.equal(retry.batchId, batch.id);
  const independent = await journal.ingest({ ...batch, id: crypto.randomUUID(), sourceId: 'alpha' }, 'pre-upgrade');
  assert.equal(independent.duplicate, false);
});

test('legacy pre-policy JSON and protobuf receipts compare original fingerprints without persisting them', async () => {
  const jsonBody = [{ message: 'legacy retry', password: 'prior-credential' }];
  const wire = concat(message(1, message(2, message(2, message(5, string(1, 'safe field'))))), string(99, 'original unknown field'));
  for (const [body, different, path, type, signal] of [
    [jsonBody, [{ ...jsonBody[0], password: 'different-credential' }], '/api/ingest', 'application/json', 'events'],
    [wire, concat(wire, string(100, 'different unknown field')), '/v1/logs', 'application/x-protobuf', 'logs'],
  ]) {
    const { env, journal } = setup({ SOURCE_TOKENS: sources() });
    const originalRequest = new Request('https://observe.test' + path, { method: 'POST', headers: { 'content-type': type }, body: type === 'application/json' ? JSON.stringify(body) : body });
    const decoded = await decodeBody(originalRequest, signal);
    const fingerprint = await sha256(JSON.stringify({ signal, payload: decoded.payload, wireBase64: decoded.wireBase64 }));
    const batchId = crypto.randomUUID(), key = 'pre-policy-key';
    journal.sql.exec('INSERT INTO receipts(key,hash,batch_id,seq,expires_at) VALUES(?,?,?,?,?)', await sha256(key), fingerprint, batchId, 41, Date.now() + 86400000);
    const response = await ingest(env, body, env.INGEST_TOKEN, key, path, type);
    assert.equal(response.status, signal === 'events' ? 202 : 200);
    const returnedId = signal === 'events' ? (await response.json()).batchId : response.headers.get('x-cf-observe-batch-id');
    assert.equal(returnedId, batchId);
    assert.equal(journal.health().pendingBatches, 0);
    assert.equal((await ingest(env, different, env.INGEST_TOKEN, key, path, type)).status, 409);
    // New scoped receipts retain the new filtered digest and cannot claim a legacy receipt.
    assert.equal((await ingest(env, body, sourceToken, key, path, type)).status, signal === 'events' ? 202 : 200);
    const current = journal.batch(1);
    assert.equal(current.sourceId, 'alpha');
    assert.equal(current.legacyDigest, undefined);
    assert.ok(!JSON.stringify(current).includes(fingerprint));
    assert.ok(!JSON.stringify(current).includes('prior-credential'));
    assert.equal(current.wireBase64, undefined);
    const scoped = journal.rows('SELECT hash FROM receipts WHERE key = ?', await sha256(JSON.stringify(['alpha', key])))[0];
    assert.notEqual(scoped.hash, fingerprint);
    assert.equal((await ingest(env, body, sourceToken, key, path, type)).status, signal === 'events' ? 202 : 200);
  }
});

test('text policy masks quoted keys inside log messages and complete Cookie header values', () => {
  const cases = [
    ['request config {"password":"quoted-secret-canary","safe":"visible"}', ['quoted-secret-canary']],
    ["request config {'api_key':'single-quoted-secret'}", ['single-quoted-secret']],
    ['headers Cookie: session=first-canary; theme=second-canary\nContent-Type: application/json', ['first-canary', 'second-canary']],
    ['response Set-Cookie: session=first-canary; token=second-canary; HttpOnly', ['first-canary', 'second-canary']],
    ['headers {"Cookie":"session=first-canary; theme=second-canary","safe":"visible"}', ['first-canary', 'second-canary']],
  ];
  for (const [message, secrets] of cases) {
    const clean = applyIngestPolicy({ payload: [{ message }], encoding: 'json' });
    assert.equal(clean.redacted, true);
    for (const secret of secrets) assert.ok(!JSON.stringify(clean).includes(secret), secret);
  }
});

test('recursive policy protects JSON string bodies and nested OTel values without erasing safe values', () => {
  const payload = {
    body: { stringValue: '{"password":"hidden-json-secret","safe":"same"}' },
    attributes: [{ key: 'safe', value: { kvlistValue: { values: [{ key: 'private_key', value: { bytesValue: 'hidden-binary' } }] } } }],
    safe: '{not valid json', nested: [null, true, 100, { public: 'text' }],
  };
  const safe = applyIngestPolicy({ payload, encoding: 'json' });
  assert.ok(!JSON.stringify(safe).includes('hidden-'));
  assert.ok(JSON.stringify(safe).includes('same'));
  assert.equal(safe.payload.safe, '{not valid json');
  assert.deepEqual(safe.payload.nested, payload.nested);
  let deeplyNested = {};
  for (let i = 0; i < 45; i++) deeplyNested = { nested: deeplyNested };
  assert.throws(() => applyIngestPolicy({ payload: deeplyNested }), error => error.status === 413);
});

test('OTLP preserves retryable and permanent statuses from the journal for either encoding', async () => {
  for (const status of [400, 409, 413, 415, 429, 502, 503, 504]) {
    for (const type of ['application/json', 'application/x-protobuf']) {
      const { env } = setup();
      const detail = 'x'.repeat(150);
      env.JOURNAL.get = () => ({ fetch: async () => new Response(JSON.stringify({ error: detail }), { status }) });
      const response = await ingest(env, type === 'application/json' ? {} : new Uint8Array(), env.INGEST_TOKEN, '', '/v1/logs', type);
      assert.equal(response.status, status);
      assert.equal(response.headers.get('retry-after'), status >= 429 ? '10' : null);
      if (type === 'application/json') assert.equal((await response.json()).message, detail);
      else {
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.deepEqual(Array.from(bytes.slice(0, 3)), [18, 150, 1]);
        assert.equal(new TextDecoder().decode(bytes.slice(3)), detail);
      }
    }
  }
});

test('batch-count pressure flushes early and rejected overflow keeps accepted records and source counters', async () => {
  const { ctx, journal, env } = setup();
  for (let i = 0; i < 63; i++) await journal.ingest(makeBatch());
  assert.ok(await ctx.storage.getAlarm() > Date.now() + 1000);
  await journal.ingest(makeBatch());
  assert.ok(await ctx.storage.getAlarm() < Date.now() + 1000);
  const before = journal.health().sources[0].acceptedBatches;
  env.MAX_PENDING_BYTES = '1024';
  const rejected = await journal.fetch(new Request('https://journal/ingest', { method: 'POST', body: JSON.stringify({ batch: makeBatch() }) }));
  assert.equal(rejected.status, 503);
  assert.equal(journal.health().sources[0].acceptedBatches, before);
  assert.equal(journal.health().pendingBatches, before);
  assert.equal(journal.health().rejectedBatches, 1);
});
