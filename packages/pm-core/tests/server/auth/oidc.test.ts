import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SignJWT,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type createRemoteJWKSet,
} from 'jose';
import { makeTestEnv } from '../../../src/testing/env';
import type { Env } from '@allenlabs/pm-core/lib/env';
import {
  _clearOidcCachesForTests,
  _setOidcDiscoveryForTests,
  _setOidcJwksForTests,
  oidcAdapter,
} from '@allenlabs/pm-core/server/auth/adapters/oidc';

// ── fixtures: a fake OIDC provider signed with EdDSA (NOT RS256) ────────────
// The JWKS lives at a NON-root path to prove the adapter resolves it from
// discovery rather than assuming a location.
const ISSUER = 'https://idp.test';
const CLIENT_ID = 'pm-client';
const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: 'https://idp.test/authorize',
  token_endpoint: 'https://idp.test/oauth/token',
  jwks_uri: 'https://idp.test/api/auth/jwks',
  end_session_endpoint: 'https://idp.test/end-session',
};

let env: Env;
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

function baseEnv(overrides: Partial<Env> = {}): Env {
  return makeTestEnv({
    AUTH_ADAPTER: 'oidc',
    OIDC_ISSUER: ISSUER,
    OIDC_CLIENT_ID: CLIENT_ID,
    ...overrides,
  });
}

async function makeIdToken(
  claims: Record<string, unknown> & { sub: string },
  opts: { aud?: string; iss?: string; nonce?: string } = {},
): Promise<string> {
  let jwt = new SignJWT({ ...claims, ...(opts.nonce ? { nonce: opts.nonce } : {}) })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'ed-test' })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600);
  return jwt.sign(privateKey);
}

beforeEach(async () => {
  _clearOidcCachesForTests();
  env = baseEnv();
  const kp = await generateKeyPair('EdDSA', { extractable: true });
  privateKey = kp.privateKey;
  publicJwk = (await exportJWK(kp.publicKey)) as Record<string, unknown>;
  publicJwk.kid = 'ed-test';
  publicJwk.alg = 'EdDSA';
  publicJwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [publicJwk as never] });
  _setOidcDiscoveryForTests(ISSUER, DISCOVERY);
  _setOidcJwksForTests(DISCOVERY.jwks_uri, jwks as unknown as ReturnType<typeof createRemoteJWKSet>);
});

afterEach(() => {
  _clearOidcCachesForTests();
  vi.unstubAllGlobals();
});

const sessionCookie = (token: string) => `pm_session=${token}`;

describe('oidcAdapter.verify (EdDSA, discovery-driven)', () => {
  it('returns null with no cookie', async () => {
    expect(await oidcAdapter.verify(env, null)).toBeNull();
  });

  it('maps standard OIDC claims to the neutral identity', async () => {
    const token = await makeIdToken({
      sub: 'oidc-sub-1',
      email: 'a@b.test',
      name: 'Alice A',
      preferred_username: 'alice',
      locale: 'ko',
      role: 'admin',
    });
    const id = await oidcAdapter.verify(env, sessionCookie(token));
    expect(id).toEqual({
      subject: 'oidc-sub-1',
      email: 'a@b.test',
      displayName: 'Alice A',
      username: 'alice',
      preferredName: 'Alice A',
      locale: 'ko',
      isPlatformAdmin: true,
      teamMemberships: [],
      tenant: null,
    });
  });

  it('applies safe defaults when role/teams/profile are absent', async () => {
    const token = await makeIdToken({ sub: 'oidc-sub-2', email: 'min@b.test' });
    const id = await oidcAdapter.verify(env, sessionCookie(token));
    expect(id).toEqual({
      subject: 'oidc-sub-2',
      email: 'min@b.test',
      displayName: null,
      username: null,
      preferredName: null,
      locale: null,
      isPlatformAdmin: false, // role absent ⇒ not admin
      teamMemberships: [], // no team claim ⇒ pm.members RBAC
      tenant: null,
    });
  });

  it('honors claim-name overrides', async () => {
    const e = baseEnv({ OIDC_CLAIM_ROLE: 'https://ns/role', OIDC_CLAIM_USERNAME: 'login' });
    const token = await makeIdToken({
      sub: 's3',
      email: 'c@d.test',
      login: 'custom',
      'https://ns/role': 'admin',
      role: 'user', // standard claim ignored in favor of the override
    });
    const id = await oidcAdapter.verify(e, sessionCookie(token));
    expect(id?.username).toBe('custom');
    expect(id?.isPlatformAdmin).toBe(true);
  });

  it('returns null for a token with the wrong audience', async () => {
    const token = await makeIdToken({ sub: 's4', email: 'e@f.test' }, { aud: 'someone-else' });
    expect(await oidcAdapter.verify(env, sessionCookie(token))).toBeNull();
  });

  it('returns null for a token from the wrong issuer', async () => {
    const token = await makeIdToken({ sub: 's5' }, { iss: 'https://evil.test' });
    expect(await oidcAdapter.verify(env, sessionCookie(token))).toBeNull();
  });

  it('returns null for a non-JWT cookie', async () => {
    expect(await oidcAdapter.verify(env, sessionCookie('not-a-jwt'))).toBeNull();
  });

  it('reads the tenant key from a configurable claim', async () => {
    const e = baseEnv({ OIDC_CLAIM_TENANT: 'org_id' });
    const token = await makeIdToken({ sub: 't1', email: 'a@b.test', org_id: 'acme' });
    const id = await oidcAdapter.verify(e, sessionCookie(token));
    expect(id?.tenant).toBe('acme');
  });
});

describe('oidcAdapter.loginRedirect (Authorization Code + PKCE)', () => {
  it('builds the authorize URL from discovery with PKCE + state cookie', async () => {
    const { href, setCookie } = await oidcAdapter.loginRedirect(env, { next: '/projects' });
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe('https://idp.test/authorize');
    expect(u.searchParams.get('response_type')).toBe('code');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/callback');
    expect(u.searchParams.get('scope')).toBe('openid profile email');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toBeTruthy();
    expect(u.searchParams.get('state')).toBeTruthy();
    expect(u.searchParams.get('nonce')).toBeTruthy();
    expect(setCookie).toContain('pm_oidc_state=');
    expect(setCookie).toContain('HttpOnly');
  });

  it('honors OIDC_SCOPES override', async () => {
    const { href } = await oidcAdapter.loginRedirect(baseEnv({ OIDC_SCOPES: 'openid email groups' }), {});
    expect(new URL(href).searchParams.get('scope')).toBe('openid email groups');
  });

  it('throws when OIDC_ISSUER is not configured', async () => {
    await expect(
      oidcAdapter.loginRedirect(makeTestEnv({ AUTH_ADAPTER: 'oidc', OIDC_CLIENT_ID: CLIENT_ID }), {}),
    ).rejects.toThrow(/OIDC_ISSUER/);
  });
});

// Drive the real login→callback handshake so state/nonce/verifier line up.
async function startLogin(next?: string) {
  const { href, setCookie } = await oidcAdapter.loginRedirect(env, next ? { next } : {});
  const state = new URL(href).searchParams.get('state')!;
  const cookieVal = /pm_oidc_state=([^;]+)/.exec(setCookie!)![1]!;
  const saved = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(cookieVal.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
    ),
  ) as { state: string; nonce: string };
  return { state, nonce: saved.nonce, cookie: `pm_oidc_state=${cookieVal}` };
}

function tokenEndpointFetch(idToken: string | null, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(idToken ? { id_token: idToken } : {}), {
      status,
    })) as unknown as typeof fetch;
}

describe('oidcAdapter.handleCallback', () => {
  it('exchanges the code (PKCE), verifies id_token + nonce, returns identity', async () => {
    const { state, nonce, cookie } = await startLogin('/projects');
    const idToken = await makeIdToken({ sub: 'cb-1', email: 'x@y.test' }, { nonce });
    const req = new Request(`https://pm.test/auth/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    const res = await oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch(idToken) });
    expect(res.identity.subject).toBe('cb-1');
    expect(res.sessionToken).toBe(idToken);
    expect(res.redirectTo).toBe('/projects');
  });

  it('rejects a state that does not match the cookie (CSRF)', async () => {
    const { cookie } = await startLogin();
    const req = new Request('https://pm.test/auth/callback?code=abc&state=forged', {
      headers: { cookie },
    });
    await expect(
      oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch('x') }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('rejects when the state cookie is missing', async () => {
    const req = new Request('https://pm.test/auth/callback?code=abc&state=s');
    await expect(
      oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch('x') }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('400 when the token exchange fails', async () => {
    const { state, cookie } = await startLogin();
    const req = new Request(`https://pm.test/auth/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    await expect(
      oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch(null, 401) }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('500 when the token response has no id_token', async () => {
    const { state, cookie } = await startLogin();
    const req = new Request(`https://pm.test/auth/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    await expect(
      oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch(null, 200) }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('500 when the id_token fails verification', async () => {
    const { state, cookie } = await startLogin();
    const req = new Request(`https://pm.test/auth/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    await expect(
      oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch('garbage') }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it('400 on a nonce mismatch', async () => {
    const { state, cookie } = await startLogin();
    const idToken = await makeIdToken({ sub: 'cb-2' }, { nonce: 'WRONG-NONCE' });
    const req = new Request(`https://pm.test/auth/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    await expect(
      oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch(idToken) }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('sends client_secret via Basic auth for a confidential client', async () => {
    const e = baseEnv({ OIDC_CLIENT_SECRET: 's3cret' });
    const { href, setCookie } = await oidcAdapter.loginRedirect(e, {});
    const state = new URL(href).searchParams.get('state')!;
    const cookieVal = /pm_oidc_state=([^;]+)/.exec(setCookie!)![1]!;
    const saved = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(cookieVal.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
      ),
    ) as { nonce: string };
    const idToken = await makeIdToken({ sub: 'cb-3' }, { nonce: saved.nonce });
    let seenAuth: string | null = null;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>).authorization ?? null;
      return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
    }) as unknown as typeof fetch;
    const req = new Request(`https://pm.test/auth/callback?code=abc&state=${state}`, {
      headers: { cookie: `pm_oidc_state=${cookieVal}` },
    });
    await oidcAdapter.handleCallback(e, req, { fetch: fetchFn });
    expect(seenAuth).toBe(`Basic ${btoa(`${CLIENT_ID}:s3cret`)}`);
  });
});

describe('oidcAdapter cookies + logout + onProjectCreated', () => {
  it('session/clear cookie helpers carry the fixed pm_session name', () => {
    expect(oidcAdapter.sessionCookie('tok')).toContain('pm_session=tok');
    expect(oidcAdapter.sessionCookie('tok')).toContain('HttpOnly');
    expect(oidcAdapter.clearSessionCookie()).toContain('Max-Age=0');
  });

  it('logout redirects to the discovered end_session_endpoint with hints', async () => {
    const token = await makeIdToken({ sub: 'lo-1' });
    const { href, setCookie } = await oidcAdapter.logout(env, sessionCookie(token));
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe('https://idp.test/end-session');
    expect(u.searchParams.get('id_token_hint')).toBe(token);
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('logout falls back to home when no end_session_endpoint is advertised', async () => {
    _clearOidcCachesForTests();
    _setOidcDiscoveryForTests(ISSUER, { ...DISCOVERY, end_session_endpoint: undefined });
    const { href } = await oidcAdapter.logout(env, null);
    expect(href).toBe('http://localhost:3000');
  });

  it('onProjectCreated is a no-op (no org/team bridge in plain OIDC)', async () => {
    const r = await oidcAdapter.onProjectCreated!(env, {
      actingExternalUserId: 'x',
      projectName: 'P',
      projectSlug: 'p',
    });
    expect(r).toEqual({ teamId: null });
  });
});

describe('oidcAdapter discovery + JWKS over the network (no pre-seed)', () => {
  // Serve BOTH the discovery document and the JWKS via a stubbed global fetch,
  // so the adapter resolves everything from discovery — including the
  // non-root JWKS path — with zero pre-seeding.
  function stubProvider() {
    vi.stubGlobal('fetch', (async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/.well-known/openid-configuration')) {
        return new Response(JSON.stringify(DISCOVERY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url === DISCOVERY.jwks_uri) {
        return new Response(JSON.stringify({ keys: [publicJwk] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch);
  }

  it('fetches discovery + JWKS and verifies an EdDSA id_token end-to-end', async () => {
    _clearOidcCachesForTests();
    stubProvider();
    const token = await makeIdToken({ sub: 'net-1', email: 'n@e.test' });
    const id = await oidcAdapter.verify(env, sessionCookie(token));
    expect(id?.subject).toBe('net-1');
  });

  it('loginRedirect throws when discovery is unreachable', async () => {
    _clearOidcCachesForTests();
    vi.stubGlobal('fetch', (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch);
    await expect(oidcAdapter.loginRedirect(env, {})).rejects.toThrow(/discovery failed/);
  });

  it('loginRedirect throws when the discovery document is incomplete', async () => {
    _clearOidcCachesForTests();
    vi.stubGlobal(
      'fetch',
      (async () => new Response(JSON.stringify({ issuer: ISSUER }), { status: 200 })) as unknown as typeof fetch,
    );
    await expect(oidcAdapter.loginRedirect(env, {})).rejects.toThrow(/missing required fields/);
  });
});

describe('oidcAdapter edge cases', () => {
  it('verify returns null when the cookie header lacks the session cookie', async () => {
    expect(await oidcAdapter.verify(env, 'other=1; another=2')).toBeNull();
  });

  it('verify returns null for an id_token with no sub claim', async () => {
    const noSub = await new SignJWT({ email: 'x@y.test' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'ed-test' })
      .setIssuer(ISSUER)
      .setAudience(CLIENT_ID)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
      .sign(privateKey);
    expect(await oidcAdapter.verify(env, sessionCookie(noSub))).toBeNull();
  });

  it('handleCallback rejects a state cookie that parses but lacks fields', async () => {
    const bad = btoa(JSON.stringify({ hello: 'world' })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const req = new Request('https://pm.test/auth/callback?code=c&state=s', {
      headers: { cookie: `pm_oidc_state=${bad}` },
    });
    await expect(
      oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch('x') }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('handleCallback rejects an undecodable state cookie', async () => {
    const req = new Request('https://pm.test/auth/callback?code=c&state=s', {
      headers: { cookie: 'pm_oidc_state=%%%not-base64%%%' },
    });
    await expect(
      oidcAdapter.handleCallback(env, req, { fetch: tokenEndpointFetch('x') }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('loginRedirect throws when OIDC_CLIENT_ID is missing', async () => {
    await expect(
      oidcAdapter.loginRedirect(makeTestEnv({ AUTH_ADAPTER: 'oidc', OIDC_ISSUER: ISSUER }), {}),
    ).rejects.toThrow(/OIDC_CLIENT_ID/);
  });

  it('handleCallback falls back to the global fetch when no deps are given', async () => {
    const { state, nonce, cookie } = await startLogin('/x');
    const idToken = await makeIdToken({ sub: 'gf-1' }, { nonce });
    vi.stubGlobal(
      'fetch',
      (async () => new Response(JSON.stringify({ id_token: idToken }), { status: 200 })) as unknown as typeof fetch,
    );
    const req = new Request(`https://pm.test/auth/callback?code=abc&state=${state}`, {
      headers: { cookie },
    });
    const res = await oidcAdapter.handleCallback(env, req); // no deps.fetch
    expect(res.identity.subject).toBe('gf-1');
  });

  it('logout with end_session but no session cookie omits id_token_hint', async () => {
    const { href } = await oidcAdapter.logout(env, null);
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe('https://idp.test/end-session');
    expect(u.searchParams.get('id_token_hint')).toBeNull();
    expect(u.searchParams.get('post_logout_redirect_uri')).toBe('http://localhost:3000');
  });
});
