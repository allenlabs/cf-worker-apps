import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeContext, makeEnv, attachNamespace } from './helpers.js';
import { TelemetryJournal } from '../src/journal.js';
const { default: worker } = await import('../src/worker.js').catch(() => ({}));
function setup() {
    const env = makeEnv(), j = new TelemetryJournal(makeContext(), env);
    attachNamespace(env, j);
    env.ASSETS = { fetch: async () => new Response('<h1>shell</h1>', { headers: { 'content-type': 'text/html' } }) };
    return { env, j };
}
const req = (path, options = {}) => new Request('https://observe.test' + path, options);
test('Worker handler exists', () => assert.equal(typeof worker?.fetch, 'function'));
test('unauthorized ingestion does not reach storage', async () => {
    const { env, j } = setup();
    const r = await worker.fetch(req('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env);
    assert.equal(r.status, 401);
    assert.equal(j.health().pendingBatches, 0);
});
test('an authenticated generic event becomes queryable before R2 flush', async () => {
    const { env } = setup();
    const r = await worker.fetch(req('/api/ingest', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.INGEST_TOKEN}` }, body: JSON.stringify([{ message: 'hello', service: 'demo' }]) }), env);
    assert.equal(r.status, 202);
    const page = await worker.fetch(req(`/api/events?from=${Date.now() - 60000}&to=${Date.now() + 1000}`, { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}` } }), env);
    assert.equal(page.status, 200);
    assert.equal((await page.json()).events.length, 1);
});
test('OTLP success returns a valid empty response, not a proprietary receipt body', async () => {
    const { env } = setup();
    const r = await worker.fetch(req('/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${env.INGEST_TOKEN}` }, body: '{}' }), env);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), {});
    assert.ok(r.headers.get('x-cf-observe-batch-id'));
});
test('login sets a secure HttpOnly cookie and exposes no token in response JSON', async () => {
    const { env } = setup();
    const r = await worker.fetch(req('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://observe.test' }, body: JSON.stringify({ token: env.VIEWER_TOKEN }) }), env);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('set-cookie'), /HttpOnly/);
    assert.match(r.headers.get('set-cookie'), /Secure/);
    assert.equal((await r.json()).token, undefined);
});
test('CSP and sensitive response cache protections are set', async () => {
    const { env } = setup();
    const r = await worker.fetch(req('/'), env);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    const api = await worker.fetch(req('/api/health', { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}` } }), env);
    assert.equal(api.headers.get('cache-control'), 'no-store');
});
test('viewer token cannot write and ingest token cannot read', async () => {
    const { env } = setup();
    const r = await worker.fetch(req('/api/health', { headers: { authorization: `Bearer ${env.INGEST_TOKEN}` } }), env);
    assert.equal(r.status, 401);
    const w = await worker.fetch(req('/api/ingest', { method: 'POST', headers: { authorization: `Bearer ${env.VIEWER_TOKEN}`, 'content-type': 'application/json' }, body: '{}' }), env);
    assert.equal(w.status, 401);
});
test('WebSocket upgrades require both authentication and the same origin', async () => {
    const { env } = setup();
    const r = await worker.fetch(req('/api/live', { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}`, upgrade: 'websocket', origin: 'https://evil.test' } }), env);
    assert.equal(r.status, 403);
});
