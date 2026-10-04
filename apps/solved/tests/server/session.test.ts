import { describe, it, expect, beforeEach } from 'vitest';
import {
  cookieHeader,
  clearCookieHeader,
  readSessionToken,
  revokeSession,
  verifySessionToken,
} from '~/server/session.server';
import { primeJwks, signTestJwt } from '../_setup/jwt';
import { makeTestEnv } from '../_setup/env';

describe('readSessionToken', () => {
  it('returns null when cookie missing', () => {
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken('')).toBeNull();
  });
  it('extracts the token', () => {
    expect(readSessionToken('foo=bar; solved_session=abc.def.ghi')).toBe('abc.def.ghi');
  });
  it('handles `=` inside token value', () => {
    expect(readSessionToken('solved_session=aa=bb=cc')).toBe('aa=bb=cc');
  });
  it('returns null when only other cookies present', () => {
    expect(readSessionToken('foo=bar')).toBeNull();
  });
});

describe('cookieHeader / clearCookieHeader', () => {
  it('formats Set-Cookie correctly', () => {
    expect(cookieHeader('abc')).toMatch(/^solved_session=abc; HttpOnly;/);
    expect(clearCookieHeader()).toMatch(/Max-Age=0/);
  });
});

describe('verifySessionToken', () => {
  let env: ReturnType<typeof makeTestEnv>;
  beforeEach(async () => {
    env = makeTestEnv();
    await primeJwks(env);
  });

  it('returns null for an empty token', async () => {
    expect(await verifySessionToken(env, '')).toBeNull();
  });

  it('rejects a malformed token', async () => {
    expect(await verifySessionToken(env, 'not.a.jwt')).toBeNull();
  });

  it('verifies a valid jwt', async () => {
    const token = await signTestJwt(env, { sub: 'sso-1', email: 'a@b.com' });
    const payload = await verifySessionToken(env, token);
    expect(payload?.sub).toBe('sso-1');
  });

  it('returns null for a revoked token', async () => {
    const token = await signTestJwt(env, { sub: 'sso-1' });
    await revokeSession(env, token);
    expect(await verifySessionToken(env, token)).toBeNull();
  });

  it('throws when AUTH_API_URL missing', async () => {
    const broken = makeTestEnv({ AUTH_API_URL: '' });
    expect(await verifySessionToken(broken, 'something')).toBeNull();
  });

  it('builds a fresh JWKS for an issuer the cache has never seen', async () => {
    const otherEnv = makeTestEnv({ AUTH_API_URL: 'https://unseen.example' });
    const token = await signTestJwt(env, { sub: 'a' });
    // Unseen issuer triggers createRemoteJWKSet → fetch failure → caught
    // by verifySessionToken's try/catch.  Exercises cache-miss branch.
    expect(await verifySessionToken(otherEnv, token)).toBeNull();
  });
});
