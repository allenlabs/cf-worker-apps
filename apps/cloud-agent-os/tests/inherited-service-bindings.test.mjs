import assert from 'node:assert/strict';
import { test } from 'node:test';
import { uploadVerifiedWorker, verifyInheritedServiceBindings } from '../scripts/upload-verified-artifacts.mjs';

const accountId = 'a'.repeat(32), activeId = '11111111-1111-4111-8111-111111111111';
const uploadedId = '22222222-2222-4222-8222-222222222222';
const worker = { name: 'synthetic-workshop', preservedServiceBindings: [{ binding: 'CONTEXT', service: 'synthetic-context',
  entrypoint: 'Vendor', environment: 'production', props: { domain: 'https://synthetic.invalid' } }] };
const visible = { name: 'CONTEXT', type: 'service', service: 'synthetic-context', entrypoint: 'Vendor', environment: 'production' };
const success = result => Response.json({ success: true, errors: [], result });
function token(t) {
  const before = process.env.CLOUDFLARE_API_TOKEN;
  process.env.CLOUDFLARE_API_TOKEN = 'synthetic-unit-test-token';
  t.after(() => { if (before === undefined) delete process.env.CLOUDFLARE_API_TOKEN; else process.env.CLOUDFLARE_API_TOKEN = before; });
}
function transport({ trace = [], bindings = [visible], active = [{ percentage: 100, version_id: activeId }], latest = activeId, settingsResponse } = {}) {
  return async (url, init) => {
    const parsed = new URL(url), endpoint = parsed.pathname.split('/').at(-1), name = parsed.pathname.split('/').at(-2);
    trace.push(`${name}:${endpoint}`);
    assert.equal(parsed.origin, 'https://api.cloudflare.com');
    assert.equal(parsed.search, '');
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
    assert.ok(init.signal instanceof AbortSignal); assert.ok(init.headers.Authorization.startsWith('Bearer '));
    if (endpoint === 'settings') return settingsResponse ? settingsResponse() : success({ bindings });
    if (endpoint === 'deployments') return success({ deployments: [{ versions: active }] });
    assert.equal(endpoint, 'versions'); return success({ items: [{ id: latest }] });
  };
}

test('checks the fresh identity and latest active version immediately before every worker upload', async t => {
  token(t);
  const trace = [], workerVersions = {};
  for (const name of ['synthetic-workshop', 'synthetic-router']) {
    workerVersions[name] = await uploadVerifiedWorker({ accountId, worker: { ...worker, name }, configPath: `${name}.json`,
      fetchImpl: transport({ trace }), execute: async path => { assert.equal(path, `${name}.json`); trace.push(`${name}:execute`); return uploadedId; } });
  }
  assert.deepEqual(trace, ['synthetic-workshop:settings', 'synthetic-workshop:deployments', 'synthetic-workshop:versions', 'synthetic-workshop:execute',
    'synthetic-router:settings', 'synthetic-router:deployments', 'synthetic-router:versions', 'synthetic-router:execute']);
  assert.deepEqual(Object.values(workerVersions), [uploadedId, uploadedId]);
});

test('an uploaded inactive version or split deployment prevents the write', async t => {
  token(t);
  for (const scenario of [{ latest: uploadedId }, { active: [{ percentage: 50, version_id: activeId }, { percentage: 50, version_id: uploadedId }] }]) {
    let writes = 0;
    await assert.rejects(uploadVerifiedWorker({ accountId, worker, configPath: 'synthetic.json', fetchImpl: transport(scenario),
      execute: async () => { writes++; return uploadedId; } }), /ARTIFACT_INHERITANCE_(LATEST_NOT_ACTIVE|ACTIVE_VERSION_UNVERIFIED)/);
    assert.equal(writes, 0);
  }
});

test('visible identity changes, missing bindings and duplicate names stop before deployment lookup', async t => {
  token(t);
  for (const bindings of [[], [visible, visible], [{ ...visible, type: 'plain_text' }], [{ ...visible, service: 'different' }],
    [{ ...visible, entrypoint: 'Different' }], [{ ...visible, environment: 'staging' }]]) {
    const trace = [];
    await assert.rejects(verifyInheritedServiceBindings({ accountId, worker, fetchImpl: transport({ trace, bindings }) }), /ARTIFACT_INHERITANCE_IDENTITY_CHANGED/);
    assert.equal(trace.length, 1);
  }
});

test('opaque props are not claimed as read, and omitted optional source identity fields are not invented', async t => {
  token(t);
  await verifyInheritedServiceBindings({ accountId, worker: { ...worker, preservedServiceBindings: [{ binding: 'CONTEXT', service: 'synthetic-context', props: { opaque: true } }] },
    fetchImpl: transport() });
});

test('HTTP denial stops without another endpoint, credential path or write', async t => {
  token(t);
  for (const status of [401, 403]) {
    const trace = []; let writes = 0;
    await assert.rejects(uploadVerifiedWorker({ accountId, worker, configPath: 'synthetic.json',
      fetchImpl: transport({ trace, settingsResponse: () => new Response(null, { status }) }), execute: async () => { writes++; return uploadedId; } }),
    /ARTIFACT_INHERITANCE_HTTP_UNVERIFIED/);
    assert.equal(trace.length, 1); assert.equal(writes, 0);
  }
});

test('oversized, malformed, incorrectly encoded and unsuccessful API responses fail closed', async t => {
  token(t);
  for (const settingsResponse of [
    () => new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': String(2 * 1024 * 1024 + 1) } }),
    () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{', { headers: { 'content-type': 'application/json' } }),
    () => new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    () => new Response('{}', { headers: { 'content-type': 'application/json; charset=latin1' } }),
    () => Response.json({ success: false, errors: [], result: { bindings: [visible] } }),
    () => Response.json({ success: true, errors: [{ code: 1000 }], result: { bindings: [visible] } }),
    () => success({}),
  ]) {
    const trace = []; let writes = 0;
    await assert.rejects(uploadVerifiedWorker({ accountId, worker, configPath: 'synthetic.json', fetchImpl: transport({ trace, settingsResponse }),
      execute: async () => { writes++; return uploadedId; } }));
    assert.equal(trace.length, 1); assert.equal(writes, 0);
  }
});

test('workers without inherited services need no token or network guard and still verify uploaded UUIDs', async () => {
  const fetchImpl = () => { throw new Error('Unexpected network call'); };
  assert.equal(await uploadVerifiedWorker({ accountId, worker: { name: 'synthetic', preservedServiceBindings: [] }, configPath: 'synthetic.json',
    fetchImpl, execute: async () => uploadedId }), uploadedId);
  await assert.rejects(uploadVerifiedWorker({ accountId, worker: { name: 'synthetic' }, configPath: 'synthetic.json', fetchImpl,
    execute: async () => undefined }), /ARTIFACT_UPLOAD_VERSION_UNVERIFIED/);
});
