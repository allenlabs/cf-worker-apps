import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestEnv } from '../_setup/env';
import { primeJwks, signTestJwt } from '../_setup/jwt';
import {
  SESSION_COOKIE,
  clearCookieHeader,
  cookieHeader,
  readSessionToken,
  revokeSession,
  verifySessionToken,
} from '~/server/session.server';

describe('verifySessionToken', () => {
  beforeEach(async () => {
    await primeJwks(makeTestEnv());
  });

  it('round-trips a payload signed against the JWKS', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, {
      sub: 'user-1',
      email: 'alice@example.test',
    });
    const payload = await verifySessionToken(env, token);
    expect(payload?.sub).toBe('user-1');
    expect(payload?.email).toBe('alice@example.test');
  });

  it('rejects an empty token', async () => {
    expect(await verifySessionToken(makeTestEnv(), '')).toBeNull();
  });

  it('rejects an expired token', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' }, { expSecondsFromNow: -10 });
    expect(await verifySessionToken(env, token)).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' });
    const [h, p, s] = token.split('.');
    const flipped = p![5] === 'A' ? 'B' : 'A';
    const munged = `${h}.${p!.slice(0, 5) + flipped + p!.slice(6)}.${s}`;
    expect(await verifySessionToken(env, munged)).toBeNull();
  });

  it('rejects a token revoked via the KV', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' });
    await revokeSession(env, token);
    expect(await verifySessionToken(env, token)).toBeNull();
  });

  it('returns null when AUTH_API_URL is missing', async () => {
    const env = makeTestEnv({ AUTH_API_URL: '' });
    const tokenEnv = makeTestEnv();
    const token = await signTestJwt(tokenEnv, { sub: 'a' });
    expect(await verifySessionToken(env, token)).toBeNull();
  });

  it('builds a fresh JWKS for an issuer the cache has never seen', async () => {
    const env = makeTestEnv({ AUTH_API_URL: 'https://unseen.example' });
    const tokenEnv = makeTestEnv();
    const token = await signTestJwt(tokenEnv, { sub: 'a' });
    expect(await verifySessionToken(env, token)).toBeNull();
  });
});

describe('readSessionToken / cookie helpers', () => {
  it('parses the cookie value', () => {
    const cookie = `other=foo; ${SESSION_COOKIE}=abc; trailing=bar`;
    expect(readSessionToken(cookie)).toBe('abc');
  });
  it('returns null with no cookie', () => {
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken('')).toBeNull();
  });
  it('returns null when cookie is absent', () => {
    expect(readSessionToken('other=x; another=y')).toBeNull();
  });
  it('cookieHeader sets HttpOnly + Secure + SameSite', () => {
    const h = cookieHeader('tok');
    expect(h).toContain(`${SESSION_COOKIE}=tok`);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('Secure');
    expect(h).toContain('SameSite=Lax');
  });
  it('cookieHeader uses the stash_session name', () => {
    expect(SESSION_COOKIE).toBe('stash_session');
  });
  it('clearCookieHeader sets Max-Age=0', () => {
    expect(clearCookieHeader()).toContain('Max-Age=0');
  });
});
