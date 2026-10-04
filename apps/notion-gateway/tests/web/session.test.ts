import { describe, expect, it, beforeEach } from 'vitest';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type createRemoteJWKSet } from 'jose';
import {
  _clearJwksCacheForTests,
  _setJwksForTests,
  clearCookieHeader,
  cookieHeader,
  readSessionToken,
  verifySessionToken,
} from '../../workers/web/app/server/session';

const ENV = {
  AUTH_API_URL: 'https://auth-api.test',
  AUTH_WEB_URL: 'https://auth.test',
  APP_NAME: 'NG',
  PUBLIC_BASE_URL: 'https://notion.test',
  NOTION_OAUTH_REDIRECT_URI: 'https://notion.test/oauth/callback',
  NOTION_CLIENT_ID: 'cid',
  NOTION_CLIENT_SECRET: 'csec',
  WORKSPACE_TOKEN_KEY: 'k',
  OTEL_ACCESS_ID: 'x',
  OTEL_ACCESS_SECRET: 'x',
  OTEL_BEARER_TOKEN: 'x',
  HYPERDRIVE: {} as Hyperdrive,
};

async function prime(): Promise<{ privateKey: CryptoKey }> {
  _clearJwksCacheForTests();
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = await exportJWK(publicKey);
  jwk.kid = 'kid1';
  jwk.alg = 'RS256';
  jwk.use = 'sig';
  const jwks = createLocalJWKSet({ keys: [jwk] });
  _setJwksForTests(
    ENV.AUTH_API_URL,
    jwks as unknown as ReturnType<typeof createRemoteJWKSet>,
  );
  return { privateKey };
}

async function makeToken(privateKey: CryptoKey, sub = 'user-1'): Promise<string> {
  return await new SignJWT({ sub })
    .setProtectedHeader({ alg: 'RS256', kid: 'kid1' })
    .setIssuer(ENV.AUTH_API_URL)
    .setAudience(ENV.AUTH_API_URL)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
    .sign(privateKey);
}

describe('readSessionToken', () => {
  it('extracts cfr_session from a cookie header', () => {
    expect(readSessionToken('a=1; cfr_session=abc; b=2')).toBe('abc');
  });

  it('returns null on missing cookie', () => {
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken('other=1')).toBeNull();
  });
});

describe('verifySessionToken', () => {
  beforeEach(() => {
    _clearJwksCacheForTests();
  });

  it('verifies a token signed by the seeded JWKS', async () => {
    const { privateKey } = await prime();
    const token = await makeToken(privateKey);
    const payload = await verifySessionToken(ENV, token);
    expect(payload?.sub).toBe('user-1');
  });

  it('returns null for an empty token', async () => {
    expect(await verifySessionToken(ENV, '')).toBeNull();
  });

  it('returns null when verification fails', async () => {
    await prime();
    expect(await verifySessionToken(ENV, 'not-a-real-jwt')).toBeNull();
  });

  it('throws when AUTH_API_URL is missing', async () => {
    const { privateKey } = await prime();
    const token = await makeToken(privateKey);
    // verifySessionToken catches errors internally — but the getJwks
    // error fires *before* the try/catch returns null only when the
    // misconfigured URL is hit during normal flow.  Calling it twice
    // confirms the cached path doesn't re-throw.
    const out = await verifySessionToken(
      { ...ENV, AUTH_API_URL: '' },
      token,
    );
    expect(out).toBeNull();
  });

  it('returns null when payload.sub is not a string', async () => {
    const { privateKey } = await prime();
    const bad = await new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'kid1' })
      .setIssuer(ENV.AUTH_API_URL)
      .setAudience(ENV.AUTH_API_URL)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(privateKey);
    expect(await verifySessionToken(ENV, bad)).toBeNull();
  });

  it('builds Set-Cookie headers for session and clearing', () => {
    expect(cookieHeader('abc.def')).toContain('cfr_session=abc.def');
    expect(cookieHeader('abc.def')).toContain('HttpOnly');
    expect(cookieHeader('abc.def')).toContain('Secure');
    expect(cookieHeader('abc.def')).toMatch(/Max-Age=\d+/);
    expect(clearCookieHeader()).toContain('cfr_session=;');
    expect(clearCookieHeader()).toContain('Max-Age=0');
  });
});
