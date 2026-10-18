import { afterEach, expect, test, vi } from 'vitest';
import worker from '../src/worker.js';
import { makeEnv } from './helpers.js';

const origin = 'https://observe.example.invalid';
const subject = 'fixture-viewer';
const config = { SSO_WEB_ORIGIN: 'https://identity.example.invalid', SSO_API_ORIGIN: 'https://identity-api.example.invalid', SSO_ALLOWED_SUBJECTS: JSON.stringify([subject]) };
const request = (path, init = {}) => new Request(origin + path, init);
function environment(extra = {}) {
  return makeEnv({ ...config, ASSETS: { fetch: vi.fn(async () => new Response('<main>private dashboard</main>', { headers: { 'content-type': 'text/html' } })) }, ...extra });
}
afterEach(() => vi.unstubAllGlobals());

test('SSO mode redirects anonymous HTML before exposing the dashboard', async () => {
  const env = environment();
  for (const path of ['/', '/index.html', '/unknown-html-fallback']) {
    const response = await worker.fetch(request(path), env);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/auth/login');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toContain('private dashboard');
  }
});

const api = (value = { user: { id: subject, email: 'viewer@example.invalid', name: null } }, status = 200) => ({ fetch: vi.fn(async () => Response.json(value, { status })) });
async function start(env) {
  const response = await worker.fetch(request('/auth/login'), env);
  expect(response.status).toBe(303);
  const target = new URL(response.headers.get('location'));
  const callback = new URL(target.searchParams.get('return_to'));
  return { response, target, callback, cookie: response.headers.get('set-cookie').split(';')[0] };
}
const complete = (env, attempt, callback = attempt.callback, cookie = attempt.cookie) => {
  const url = new URL(callback); url.searchParams.append('code', 'fixture-code');
  return worker.fetch(new Request(url, { headers: cookie ? { cookie } : {} }), env);
};

test('partial, non-TLS and malformed SSO configuration fail closed before assets', async () => {
  for (const change of [
    { SSO_WEB_ORIGIN: undefined }, { SSO_API_ORIGIN: undefined }, { SSO_ALLOWED_SUBJECTS: undefined },
    { SSO_WEB_ORIGIN: 'http://identity.example.invalid' }, { SSO_API_ORIGIN: 'https://identity-api.example.invalid/' },
    { SSO_WEB_ORIGIN: 'https://user:password@identity.example.invalid' }, { SSO_WEB_ORIGIN: 'https://identity.example.invalid/?query=1' },
    { SSO_ALLOWED_SUBJECTS: '{}' }, { SSO_ALLOWED_SUBJECTS: '[]' }, { SSO_ALLOWED_SUBJECTS: 'invalid' },
    { SSO_ALLOWED_SUBJECTS: JSON.stringify([subject, subject]) }, { SSO_ALLOWED_SUBJECTS: '[" "]' },
    { SSO_ALLOWED_SUBJECTS: JSON.stringify(['x'.repeat(256)]) }, { SSO_ALLOWED_SUBJECTS: JSON.stringify(Array.from({ length: 101 }, (_, i) => String(i))) },
    { AUTH_API: {} },
  ]) {
    const env = environment(change);
    const response = await worker.fetch(request('/'), env);
    expect(response.status).toBe(503);
    expect(env.ASSETS.fetch).not.toHaveBeenCalled();
  }
});

test('optional mode preserves the demo/token flow and public JS, health and ingest protocols', async () => {
  const plain = environment({ SSO_WEB_ORIGIN: undefined, SSO_API_ORIGIN: undefined, SSO_ALLOWED_SUBJECTS: undefined });
  expect((await worker.fetch(request('/'), plain)).status).toBe(200);
  const login = await worker.fetch(request('/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: plain.VIEWER_TOKEN }) }), plain);
  expect(login.status).toBe(200); expect(login.headers.get('set-cookie')).toContain('SameSite=Strict');
  expect((await worker.fetch(request('/api/health'), plain)).headers.has('x-cf-observe-login')).toBe(false);
  const env = environment({ ASSETS: { fetch: async () => new Response('export {}', { headers: { 'content-type': 'application/javascript' } }) } });
  expect((await worker.fetch(request('/app.js'), env)).status).toBe(200);
  expect((await worker.fetch(request('/healthz'), environment({ SSO_WEB_ORIGIN: undefined }))).status).toBe(200);
  const ingest = await worker.fetch(request('/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }), env);
  expect(ingest.status).toBe(401); expect(ingest.headers.has('location')).toBe(false);
});

test('SSO mode disables token-to-cookie login and browser bearer authentication while retaining CLI bearer', async () => {
  const env = environment();
  const login = await worker.fetch(request('/api/session', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token: env.VIEWER_TOKEN }) }), env);
  expect(login.status).toBe(403); expect(login.headers.has('set-cookie')).toBe(false);
  for (const browserHeaders of [{ origin }, { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-mode': 'cors' }, { 'sec-fetch-dest': 'empty' }]) {
    const response = await worker.fetch(request('/api/unknown', { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}`, ...browserHeaders } }), env);
    expect(response.status).toBe(401); expect(response.headers.get('x-cf-observe-login')).toBe('/auth/login');
    expect(response.headers.has('location')).toBe(false);
  }
  expect((await worker.fetch(request('/api/unknown', { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}` } }), env)).status).toBe(404);
  const old = await worker.fetch(request('/api/session', { method: 'POST', body: '{}' }), environment({ SSO_WEB_ORIGIN: undefined, SSO_API_ORIGIN: undefined, SSO_ALLOWED_SUBJECTS: undefined }));
  expect(old.status).toBe(401);
});

test('SSO login creates HTTPS browser-bound expiring state and a fixed callback', async () => {
  const env = environment(), attempt = await start(env);
  expect(attempt.target.origin + attempt.target.pathname).toBe(config.SSO_WEB_ORIGIN + '/sign-in');
  expect(attempt.callback.origin + attempt.callback.pathname).toBe(origin + '/auth/callback');
  expect(attempt.callback.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const cookie = attempt.response.headers.get('set-cookie');
  for (const flag of ['__Host-', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) expect(cookie).toContain(flag);
  expect(cookie).not.toContain(env.VIEWER_TOKEN);
  expect(attempt.response.headers.get('cache-control')).toBe('no-store');
  expect((await worker.fetch(new Request('http://observe.example.invalid/auth/login'), env)).status).toBe(503);
  expect((await worker.fetch(request('/auth/login', { method: 'POST' }), env)).status).toBe(405);
});

test('only exact browser state and one bounded code reach the exchange', async () => {
  const env = environment({ AUTH_API: api() }), attempt = await start(env);
  for (const query of ['code=fixture-code', 'state=bad&code=fixture-code', attempt.callback.search.slice(1) + '&state=extra&code=fixture-code', attempt.callback.search.slice(1) + '&code=a&code=b', attempt.callback.search.slice(1) + '&code=a&next=//external.invalid', attempt.callback.search.slice(1) + '&code=' + 'x'.repeat(2049)]) {
    const response = await worker.fetch(request('/auth/callback?' + query), env);
    expect([400, 401]).toContain(response.status); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
  }
  expect((await complete(env, attempt, attempt.callback, '')).status).toBe(401);
  expect((await complete(env, attempt, attempt.callback, attempt.cookie + '; ' + attempt.cookie)).status).toBe(401);
  expect((await complete(env, attempt, attempt.callback, attempt.cookie + 'corrupt')).status).toBe(401);
  const altered = new URL(attempt.callback); altered.searchParams.set('state', 'a'.repeat(43));
  expect((await complete(env, attempt, altered)).status).toBe(401);
  const other = new URL(attempt.callback); other.hostname = 'other.example.invalid';
  expect((await complete(env, attempt, other)).status).toBe(401);
  expect(env.AUTH_API.fetch).not.toHaveBeenCalled();
});

test('an allowed SSO subject gets only the existing signed viewer session after the fixed exchange', async () => {
  const env = environment({ AUTH_API: api({ user: { id: subject }, expires_in: 999999 }) }), attempt = await start(env);
  const response = await complete(env, attempt);
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/');
  expect(response.headers.get('set-cookie')).toContain('Max-Age=28800');
  expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
  expect(response.headers.get('set-cookie')).not.toContain(env.VIEWER_TOKEN);
  const sent = env.AUTH_API.fetch.mock.calls[0][0];
  expect(sent.url).toBe(config.SSO_API_ORIGIN + '/sso/exchange'); expect(sent.redirect).toBe('manual');
  expect(await sent.json()).toEqual({ code: 'fixture-code', client_id: origin, include_token: false });
  expect(await response.text()).toBe('');
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-cf_observe=')).split(';')[0];
  const read = await worker.fetch(request('/api/unknown', { headers: { cookie, origin } }), env);
  expect(read.status).toBe(404); expect(read.headers.has('x-cf-observe-login')).toBe(false);
  expect((await worker.fetch(request('/api/unknown', { headers: { cookie, origin: 'https://external.example.invalid' } }), env)).status).toBe(403);
  const logout = await worker.fetch(request('/api/session', { method: 'DELETE', headers: { cookie, origin } }), env);
  expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0'); expect(logout.headers.has('location')).toBe(false);
});

test('expired state and historical token sessions cannot become SSO browser sessions', async () => {
  const { sign } = await import('../src/auth.js');
  const env = environment({ AUTH_API: api() }), attempt = await start(env);
  const proof = await sign(env, { purpose: 'sso-state', origin, state: attempt.callback.searchParams.get('state'), exp: 1 });
  expect((await complete(env, attempt, attempt.callback, '__Host-cf_observe_sso_state=' + proof)).status).toBe(401);
  expect(env.AUTH_API.fetch).not.toHaveBeenCalled();
  const legacy = await sign(env, { purpose: 'session', exp: Date.now() + 10000 });
  expect((await worker.fetch(request('/api/unknown', { headers: { cookie: '__Host-cf_observe=' + legacy, origin } }), env)).status).toBe(401);
  const unboundSso = await sign(env, { purpose: 'session', sso: true, exp: Date.now() + 10000 });
  expect((await worker.fetch(request('/api/unknown', { headers: { cookie: '__Host-cf_observe=' + unboundSso, origin } }), env)).status).toBe(401);
});

test('email, role and a different SSO subject never grant viewer access', async () => {
  const env = environment({ AUTH_API: api({ user: { id: 'not-allowed', email: subject, role: 'admin' } }) }), attempt = await start(env);
  const response = await complete(env, attempt);
  expect(response.status).toBe(403); expect(response.headers.has('location')).toBe(false);
  expect(response.headers.get('set-cookie')).not.toContain('__Host-cf_observe=');
  expect(await response.text()).not.toContain('not-allowed');
});

test('upstream denials, network errors and malformed responses fail once without fallback or raw errors', async () => {
  for (const [status, body, type, expected] of [
    [302, '{}', 'application/json', 401], [401, '{}', 'application/json', 401], [403, '{}', 'application/json', 401], [500, '{}', 'application/json', 503],
    [200, '<html>private error</html>', 'text/html', 502], [200, '{', 'application/json', 502], [200, 'x'.repeat(16385), 'application/json', 502],
    [200, '{"user":{"id":""}}', 'application/json', 502], [200, '{"user":{"id":"fixture-viewer"},"expires_in":0}', 'application/json', 502],
    [200, new Uint8Array([255, 254]), 'application/json', 502],
  ]) {
    const env = environment({ AUTH_API: { fetch: vi.fn(async () => new Response(body, { status, headers: { 'content-type': type } })) } });
    const attempt = await start(env), response = await complete(env, attempt);
    expect(response.status).toBe(expected); expect(response.headers.has('location')).toBe(false);
    expect(env.AUTH_API.fetch).toHaveBeenCalledTimes(1); expect(await response.text()).not.toContain('private error');
  }
  const remote = vi.fn(async () => { throw Error('private network details'); });
  vi.stubGlobal('fetch', remote);
  const bound = environment({ AUTH_API: { fetch: vi.fn(async () => { throw Error('private binding details'); }) } });
  const response = await complete(bound, await start(bound));
  expect(response.status).toBe(503); expect(remote).not.toHaveBeenCalled(); expect(await response.text()).not.toContain('private');
  remote.mockImplementation(async () => Response.json({ user: { id: subject }, expires_in: 30 }));
  const direct = environment(), result = await complete(direct, await start(direct));
  expect(result.status).toBe(303); expect(result.headers.get('set-cookie')).toContain('Max-Age=30'); expect(remote).toHaveBeenCalledTimes(1);
});


test.each([
  ['removed subject', { SSO_ALLOWED_SUBJECTS: '["different-viewer"]' }, origin],
  ['changed issuer', { SSO_API_ORIGIN: 'https://other-identity-api.example.invalid' }, origin],
  ['changed application origin', {}, 'https://other-observe.example.invalid'],
])('existing SSO session rejects %s under current policy', async (_reason, changes, requestOrigin) => {
  const env = environment({ AUTH_API: api() });
  const response = await complete(env, await start(env));
  expect(response.status).toBe(303);
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-cf_observe=')).split(';')[0];
  expect((await worker.fetch(request('/api/unknown', { headers: { cookie, origin } }), env)).status).toBe(404);
  const denied = await worker.fetch(new Request(requestOrigin + '/api/unknown', { headers: { cookie, origin: requestOrigin } }), { ...env, ...changes });
  expect(denied.status).toBe(401);
  expect(denied.headers.get('x-cf-observe-login')).toBe('/auth/login');
  expect(denied.headers.has('location')).toBe(false);
  expect(env.AUTH_API.fetch).toHaveBeenCalledTimes(1);
});


test('identity-only SSO exchange uses its zero-expiry sentinel without accepting a provider token', async () => {
  const env = environment({ AUTH_API: api({ token: '', expires_in: 0, user: { id: subject, email: 'viewer@example.invalid', name: null } }) });
  const response = await complete(env, await start(env));
  expect(response.status).toBe(303);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=28800');
  const cookie = response.headers.getSetCookie().find(value => value.startsWith('__Host-cf_observe=')).split(';')[0];
  expect((await worker.fetch(request('/api/unknown', { headers: { cookie, origin } }), env)).status).toBe(404);
  const unexpected = environment({ AUTH_API: api({ token: 'unexpected-central-token', expires_in: 60, user: { id: subject } }) });
  const denied = await complete(unexpected, await start(unexpected));
  expect(denied.status).toBe(502);
  expect(denied.headers.get('set-cookie')).not.toContain('__Host-cf_observe=');
  expect(await denied.text()).not.toContain('unexpected-central-token');
});
