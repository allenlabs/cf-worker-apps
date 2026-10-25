import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// Only the SDK's error classes are used here; the full Worker is exercised by check.mjs.
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') return { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true };
  return next(specifier, context);
} });
const { MAX_BODY, encoder, identifier, publicOrigin, fail, canonical, digest, equal,
  bodyBytes, bodyText, signingKey, callbackUrl, sendSigned } = await import('../../workers/api/protocol.js');
const { ownerConsent } = await import('../../workers/api/oauth.js');
const { AuthorizationError, CimdFetchError } = await import('@cloudflare/workers-oauth-provider');

test('shared identity, origin and error contracts retain their boundaries', () => {
  assert.equal(MAX_BODY, 256 * 1024);
  assert.ok(encoder instanceof TextEncoder);
  for (const value of ['sample-owner', 'A_1', 'a'.repeat(255)]) assert.equal(identifier(value), true);
  for (const value of ['', 1, 'a/b', 'a'.repeat(256), '한글']) assert.equal(identifier(value), false);
  assert.equal(publicOrigin({ PUBLIC_ORIGIN: 'https://events.example.invalid' }), 'https://events.example.invalid');
  for (const value of [undefined, 'http://events.example.invalid', 'https://events.example.invalid/',
    'https://owner@events.example.invalid', 'https://events.example.invalid:443', 'https://events.example.invalid/path']) {
    assert.equal(publicOrigin({ PUBLIC_ORIGIN: value }), null);
  }
  assert.throws(() => fail('Invalid fixture'), { message: 'Invalid fixture', code: -32602 });
  assert.throws(() => fail('Rejected fixture', 413, { reason: 'fixture' }), { code: 413, data: { reason: 'fixture' } });
});

test('shared canonicalization and hashing preserve exact Unicode input', async () => {
  assert.equal(canonical({ z: 1, a: { z: 2, a: 3 } }), '{"a":{"z":2,"a":3},"z":1}');
  const text = '한글🙂\nfixture';
  assert.equal(await digest(text), createHash('sha256').update(text).digest('hex'));
  assert.equal(await equal(text, text), true);
  assert.equal(await equal(text, text + ' '), false);
});

test('shared body readers keep the byte limit and strict UTF-8 decoding', async () => {
  assert.deepEqual(await bodyBytes(new Request('https://example.invalid')), new Uint8Array());
  const bytes = encoder.encode('가🙂');
  assert.equal(await bodyText(new Response(bytes), bytes.length), '가🙂');
  await assert.rejects(() => bodyBytes(new Response(bytes, { headers: { 'Content-Length': String(bytes.length) } }), bytes.length - 1), { code: 413 });
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
  await assert.rejects(() => bodyBytes({ headers: new Headers(), body }, bytes.length - 1), { code: 413 });
  assert.equal(cancelled, true);
  await assert.rejects(() => bodyText(new Response(new Uint8Array([0xc3, 0x28]))), TypeError);
  await assert.rejects(() => bodyBytes(new Response(new Uint8Array(MAX_BODY + 1))), { code: 413 });
});

test('shared signing secrets and callback URLs retain the existing allowlist', () => {
  for (const length of [24, 32, 64]) {
    const bytes = Buffer.alloc(length, 0xab);
    assert.deepEqual(signingKey(`whsec_${bytes.toString('base64')}`), new Uint8Array(bytes));
  }
  for (const secret of ['invalid', 'whsec_???', `whsec_${Buffer.alloc(23).toString('base64')}`, `whsec_${Buffer.alloc(65).toString('base64')}`]) {
    assert.throws(() => signingKey(secret), { code: -32602 });
  }
  assert.equal(callbackUrl('https://chatgpt.com:443/events'), 'https://chatgpt.com/events');
  assert.equal(callbackUrl('https://hooks.openai.com/events'), 'https://hooks.openai.com/events');
  for (const url of ['http://chatgpt.com/events', 'https://chatgpt.com.evil.invalid/events', 'https://chatgpt.com:444/events',
    'https://key@chatgpt.com/events', 'https://chatgpt.com/events#fragment']) {
    assert.throws(() => callbackUrl(url), { code: -32602 });
  }
  assert.throws(() => callbackUrl('https://example.invalid/private?secret=fixture'), { data: { callbackHost: 'example.invalid' } });
});

test('shared webhook delivery preserves signed bytes, rotation and request options', async t => {
  const now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const current = `whsec_${Buffer.alloc(32, 1).toString('base64')}`;
  const previous = `whsec_${Buffer.alloc(32, 2).toString('base64')}`;
  const subscription = { id: 'sub_fixture', delivery: { url: 'https://chatgpt.com/events', secret: current }, previousSecret: previous, rotationUntil: now + 1 };
  const body = JSON.stringify({ text: '가🙂', eventId: 'evt_fixture' });
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push({ url, options }); return new Response(null, { status: 202 }); });
  assert.equal((await sendSigned(subscription, body, 'evt_fixture')).status, 202);
  const { url, options } = calls[0];
  assert.equal(url, subscription.delivery.url);
  assert.equal(options.body, body);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'manual');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.headers['webhook-id'], 'evt_fixture');
  assert.equal(options.headers['webhook-timestamp'], '1000');
  assert.equal(options.headers['X-MCP-Subscription-Id'], subscription.id);
  const expected = [current, previous].map(secret => 'v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`evt_fixture.1000.${body}`).digest('base64'));
  assert.equal(options.headers['webhook-signature'], expected.join(' '));
  await sendSigned({ ...subscription, rotationUntil: now }, body, 'evt_fixture');
  assert.equal(calls[1].options.headers['webhook-signature'], expected[0]);
  await assert.rejects(() => sendSigned(subscription, 'x'.repeat(MAX_BODY + 1), 'evt_fixture'), { code: 413 });
  assert.equal(calls.length, 2);
});

const origin = 'https://events.example.invalid';
const ownerKey = 'synthetic-owner-key-at-least-thirty-two-characters';
const consentOptions = { scope: 'fixture:events', productName: 'Fixture Events', description: 'This permits fixture event subscriptions.', metadata: { fixture: 'source' } };
function fixture(overrides = {}) {
  const calls = [];
  const authRequest = { clientId: 'fixture-client' };
  const approvedRequest = { clientId: 'approved-fixture-client' };
  const oauth = {
    async parseAuthRequest(request) { calls.push(['parse', request]); return authRequest; },
    async describeConsent(value) { calls.push(['describe', value]); return { scope: [consentOptions.scope], clientName: 'Client <fixture>', clientDomain: 'client.example.invalid', redirectHost: 'chatgpt.com', redirectIsLoopback: false }; },
    async beginConsent(value) { calls.push(['begin', value]); return { handle: 'fixture-handle', headers: new Headers({ 'Set-Cookie': 'fixture=bound; HttpOnly', 'X-Frame-Options': 'DENY' }) }; },
    async denyConsent(request, handle) { calls.push(['deny', request, handle]); return { redirectTo: 'https://chatgpt.com/oauth/callback?error=access_denied', headers: new Headers({ 'Set-Cookie': 'fixture=; Max-Age=0' }) }; },
    async approveConsent(request, handle, options) { calls.push(['approve', request, handle, options]); return { request: approvedRequest, headers: new Headers({ 'Set-Cookie': 'fixture=; Max-Age=0' }) }; },
    async completeAuthorization(options) { calls.push(['complete', options]); return { redirectTo: 'https://chatgpt.com/oauth/callback?code=fixture' }; },
    ...overrides,
  };
  return { calls, authRequest, approvedRequest, env: { OWNER_LOGIN_KEY: ownerKey, OAUTH_OWNER_ID: 'fixture-owner', OAUTH_PROVIDER: oauth } };
}
const getRequest = () => new Request(origin + '/authorize');
const postRequest = (values = {}) => new Request(origin + '/authorize', { method: 'POST', body: new URLSearchParams({ handle: 'fixture-handle', decision: 'approve', owner_key: ownerKey, ...values }) });

test('owner consent renders configured labels with escaped client details and retained browser headers', async () => {
  const f = fixture();
  const request = getRequest();
  const response = await ownerConsent(request, f.env, { ...consentOptions, productName: 'Fixture <Events>', description: 'Read <fixture> & events.' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/html; charset=utf-8');
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY');
  assert.equal(response.headers.get('Set-Cookie'), 'fixture=bound; HttpOnly');
  const html = await response.text();
  assert.ok(html.includes('<title>Fixture &#60;Events&#62; access</title>'));
  assert.ok(html.includes('Connect Fixture &#60;Events&#62;'));
  assert.ok(html.includes('Client &#60;fixture&#62;'));
  assert.ok(html.includes('Scope: fixture:events. Read &#60;fixture&#62; &#38; events.'));
  assert.deepEqual(f.calls.map(call => call[0]), ['parse', 'describe', 'begin']);
  assert.equal(f.calls[0][1], request);
  assert.equal(f.calls[2][1], f.authRequest);
});

test('owner consent preserves loopback warnings and rejects unsupported scopes before beginning consent', async () => {
  const loopback = fixture({ async describeConsent() { return { scope: [consentOptions.scope], clientName: 'Fixture', redirectHost: 'localhost', redirectIsLoopback: true }; } });
  const html = await (await ownerConsent(getRequest(), loopback.env, consentOptions)).text();
  assert.ok(html.includes('(self-registered name)'));
  assert.ok(html.includes('Continue only if you started this sign-in.'));
  for (const scopes of [[], ['other:events'], [consentOptions.scope, 'other:events']]) {
    const f = fixture({ async describeConsent() { return { scope: scopes }; } });
    assert.equal((await ownerConsent(getRequest(), f.env, consentOptions)).status, 400);
    assert.equal(f.calls.some(call => call[0] === 'begin'), false);
  }
});

test('owner consent approval retains owner, scope, custom metadata, props and response headers', async () => {
  const f = fixture();
  const request = postRequest();
  const response = await ownerConsent(request, f.env, consentOptions);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://chatgpt.com/oauth/callback?code=fixture');
  assert.equal(response.headers.get('Set-Cookie'), 'fixture=; Max-Age=0');
  assert.deepEqual(f.calls[0], ['approve', request, 'fixture-handle', { scope: [consentOptions.scope] }]);
  assert.deepEqual(f.calls[1], ['complete', { request: f.approvedRequest, userId: 'fixture-owner', scope: [consentOptions.scope], metadata: consentOptions.metadata, props: { userId: 'fixture-owner' } }]);
});

test('owner consent denial does not authenticate or approve a grant', async () => {
  const f = fixture();
  const response = await ownerConsent(postRequest({ decision: 'deny', owner_key: '' }), f.env, consentOptions);
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), 'https://chatgpt.com/oauth/callback?error=access_denied');
  assert.deepEqual(f.calls.map(call => call[0]), ['deny']);
});

test('owner consent preserves configuration, owner-key, method and invalid-body failures', async () => {
  for (const key of [undefined, '', 'short']) {
    const f = fixture(); f.env.OWNER_LOGIN_KEY = key;
    assert.equal((await ownerConsent(getRequest(), f.env, consentOptions)).status, 503);
    assert.equal(f.calls.length, 0);
  }
  for (const key of ['', 'wrong-fixture-key', 'x'.repeat(257)]) {
    const f = fixture();
    assert.equal((await ownerConsent(postRequest({ owner_key: key }), f.env, consentOptions)).status, 401);
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  assert.equal((await ownerConsent(new Request(origin + '/authorize', { method: 'PUT' }), f.env, consentOptions)).status, 405);
  for (const body of ['x'.repeat(16385), new Uint8Array([0xc3, 0x28])]) {
    assert.equal((await ownerConsent(new Request(origin + '/authorize', { method: 'POST', body }), f.env, consentOptions)).status, 500);
  }
  assert.equal(f.calls.length, 0);
});

test('owner consent preserves typed OAuth error handling without disclosing internal messages', async () => {
  const redirected = new AuthorizationError('invalid_scope', { description: 'Fixture scope denied', redirectUri: 'https://chatgpt.com/oauth/callback', state: 'fixture-state' });
  const errors = [redirected, new AuthorizationError('invalid_request', { description: 'internal fixture' }), new CimdFetchError('https://client.example.invalid/meta', Error('internal fixture')), Error('internal fixture')];
  for (const [index, error] of errors.entries()) {
    const f = fixture({ async parseAuthRequest() { throw error; } });
    const response = await ownerConsent(getRequest(), f.env, consentOptions);
    assert.equal(response.status, index === 0 ? 302 : index === 3 ? 500 : 400);
    if (index === 0) assert.equal(response.headers.get('Location'), redirected.redirectTo);
    else assert.ok(!(await response.text()).includes('internal fixture'));
  }
});
