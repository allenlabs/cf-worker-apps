import { afterEach, expect, test, vi } from 'vitest';
import worker from '../../src/worker.js';
import { env as runtimeEnv } from 'cloudflare:workers';

const origin = 'https://observe.example.invalid';
const subject = 'fixture-viewer';
const config = { SSO_WEB_ORIGIN: 'https://identity.example.invalid', SSO_API_ORIGIN: 'https://identity-api.example.invalid', SSO_ALLOWED_SUBJECTS: JSON.stringify([subject]) };
const request = (path, init = {}) => new Request(origin + path, init);
function environment(extra = {}) {
  return { ...runtimeEnv, ...config, ASSETS: { fetch: vi.fn(async () => new Response('<main>private dashboard</main>', { headers: { 'content-type': 'text/html' } })) }, ...extra };
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

const api = (id = subject) => ({ fetch: vi.fn(async () => Response.json({ user: { id }, expires_in: 600 })) });
async function connect(env) {
  const login = await worker.fetch(request('/auth/login'), env);
  expect(login.status).toBe(303);
  const target = new URL(login.headers.get('location'));
  const callback = new URL(target.searchParams.get('return_to'));
  callback.searchParams.set('code', 'native-one-time-code');
  const state = login.headers.get('set-cookie').split(';')[0];
  const response = await worker.fetch(new Request(callback, { headers: { cookie: state } }), env);
  return { response, cookie: response.headers.getSetCookie().find(value => value.startsWith('__Host-cf_observe='))?.split(';')[0] };
}

test('native SSO exchange issues an expiring signed viewer cookie, rewrites HTML and preserves CLI bearer', async () => {
  const assets = '<!doctype html><html><body><main>private dashboard</main><dialog id="loginDialog"><form id="loginForm"><input id="viewerToken" type="password"></form></dialog><script type="module" src="/app.js"></script></body></html>';
  const env = environment({ AUTH_API: api(), ASSETS: { fetch: async () => new Response(assets, { headers: { 'content-type': 'text/html' } }) } });
  const { response, cookie } = await connect(env);
  expect(response.status).toBe(303); expect(response.headers.get('location')).toBe('/');
  expect(cookie).toBeTruthy(); expect(response.headers.get('set-cookie')).toContain('Max-Age=600');
  expect(response.headers.get('set-cookie')).toContain('HttpOnly'); expect(response.headers.get('set-cookie')).toContain('SameSite=Lax');
  const exchange = env.AUTH_API.fetch.mock.calls[0][0];
  expect(exchange.url).toBe(config.SSO_API_ORIGIN + '/sso/exchange');
  expect(await exchange.json()).toEqual({ code: 'native-one-time-code', client_id: origin, include_token: false });
  const page = await worker.fetch(request('/', { headers: { cookie, 'sec-fetch-mode': 'navigate' } }), env);
  expect(page.status).toBe(200); expect(page.headers.get('cache-control')).toBe('no-store');
  const html = await page.text();
  expect(html).toContain('data-sso="true"'); expect(html).toContain('private dashboard'); expect(html).toContain('href="/auth/login"');
  expect(html).not.toContain('viewerToken'); expect(html).not.toContain('loginForm'); expect(html).not.toContain(env.VIEWER_TOKEN);
  expect((await worker.fetch(request('/api/health', { headers: { cookie, origin } }), env)).status).toBe(200);
  expect((await worker.fetch(request('/api/health', { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}` } }), env)).status).toBe(200);
  const browserPat = await worker.fetch(request('/api/health', { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}`, 'sec-fetch-site': 'same-origin' } }), env);
  expect(browserPat.status).toBe(401); expect(browserPat.headers.get('x-cf-observe-login')).toBe('/auth/login'); expect(browserPat.headers.has('location')).toBe(false);
  expect((await worker.fetch(request('/api/session', { method: 'POST', headers: { origin }, body: JSON.stringify({ token: env.VIEWER_TOKEN }) }), env)).status).toBe(403);
  expect((await worker.fetch(request('/api/live', { headers: { cookie, origin: 'https://untrusted.example.invalid', upgrade: 'websocket' } }), env)).status).toBe(403);
  const logout = await worker.fetch(request('/api/session', { method: 'DELETE', headers: { cookie, origin } }), env);
  expect(logout.status).toBe(200); expect(logout.headers.get('set-cookie')).toContain('Max-Age=0'); expect(logout.headers.has('location')).toBe(false);
});

test('native browser state, strict subject authorization and partial configuration fail closed', async () => {
  const env = environment({ AUTH_API: api() });
  const missing = await worker.fetch(request('/auth/callback?state=' + 'a'.repeat(43) + '&code=fixture'), env);
  expect(missing.status).toBe(401); expect(env.AUTH_API.fetch).not.toHaveBeenCalled();
  const denied = await connect(environment({ AUTH_API: api('unlisted-subject') }));
  expect(denied.response.status).toBe(403); expect(denied.cookie).toBeUndefined(); expect(denied.response.headers.has('location')).toBe(false);
  const broken = environment({ SSO_ALLOWED_SUBJECTS: '[]' });
  expect((await worker.fetch(request('/'), broken)).status).toBe(503); expect(broken.ASSETS.fetch).not.toHaveBeenCalled();
});


test.each([
  ['removed subject', { SSO_ALLOWED_SUBJECTS: '["different-viewer"]' }, origin],
  ['changed issuer', { SSO_API_ORIGIN: 'https://other-identity-api.example.invalid' }, origin],
  ['changed application origin', {}, 'https://other-observe.example.invalid'],
])('native existing SSO session rejects %s under current policy', async (_reason, changes, requestOrigin) => {
  const env = environment({ AUTH_API: api() });
  const { response, cookie } = await connect(env);
  expect(response.status).toBe(303);
  expect((await worker.fetch(request('/api/unknown', { headers: { cookie, origin } }), env)).status).toBe(404);
  const denied = await worker.fetch(new Request(requestOrigin + '/api/unknown', { headers: { cookie, origin: requestOrigin } }), { ...env, ...changes });
  expect(denied.status).toBe(401);
  expect(denied.headers.get('x-cf-observe-login')).toBe('/auth/login');
  expect(denied.headers.has('location')).toBe(false);
  expect(env.AUTH_API.fetch).toHaveBeenCalledTimes(1);
});


test('native identity-only SSO exchange uses the empty-token zero-expiry contract', async () => {
  const env = environment({ AUTH_API: { fetch: vi.fn(async () => Response.json({ token: '', expires_in: 0, user: { id: subject, email: 'viewer@example.invalid', name: null } })) } });
  const { response, cookie } = await connect(env);
  expect(response.status).toBe(303);
  expect(response.headers.get('set-cookie')).toContain('Max-Age=28800');
  expect((await worker.fetch(request('/api/unknown', { headers: { cookie, origin } }), env)).status).toBe(404);
});
