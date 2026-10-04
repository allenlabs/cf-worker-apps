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
  });

  it('rejects empty token', async () => {
    expect(await verifySessionToken(makeTestEnv(), '')).toBeNull();
  });

  it('rejects expired token', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' }, { expSecondsFromNow: -10 });
    expect(await verifySessionToken(env, token)).toBeNull();
  });

  it('rejects revoked token', async () => {
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

  it('builds a fresh JWKS for an unseen issuer', async () => {
    const env = makeTestEnv({ AUTH_API_URL: 'https://unseen.example' });
    const tokenEnv = makeTestEnv();
    const token = await signTestJwt(tokenEnv, { sub: 'a' });
    expect(await verifySessionToken(env, token)).toBeNull();
  });
});

describe('cookie helpers', () => {
  it('parses cookie value', () => {
    expect(readSessionToken(`other=foo; ${SESSION_COOKIE}=abc`)).toBe('abc');
  });
  it('null with no cookie', () => {
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken('')).toBeNull();
    expect(readSessionToken('other=x')).toBeNull();
  });
  it('cookieHeader sets attrs', () => {
    const h = cookieHeader('tok');
    expect(h).toContain(`${SESSION_COOKIE}=tok`);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('Secure');
    expect(h).toContain('SameSite=Lax');
  });
  it('SESSION_COOKIE is nudge_session', () => {
    expect(SESSION_COOKIE).toBe('nudge_session');
  });
  it('clearCookieHeader sets Max-Age=0', () => {
    expect(clearCookieHeader()).toContain('Max-Age=0');
  });
});
