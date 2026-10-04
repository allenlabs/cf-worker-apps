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

  it('round-trips', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'user-1', email: 'a@x.com' });
    const payload = await verifySessionToken(env, token);
    expect(payload?.sub).toBe('user-1');
  });
  it('rejects empty', async () => {
    expect(await verifySessionToken(makeTestEnv(), '')).toBeNull();
  });
  it('rejects expired', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' }, { expSecondsFromNow: -10 });
    expect(await verifySessionToken(env, token)).toBeNull();
  });
  it('rejects revoked', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' });
    await revokeSession(env, token);
    expect(await verifySessionToken(env, token)).toBeNull();
  });
  it('null when AUTH_API_URL missing', async () => {
    const env = makeTestEnv({ AUTH_API_URL: '' });
    const tokenEnv = makeTestEnv();
    const token = await signTestJwt(tokenEnv, { sub: 'a' });
    expect(await verifySessionToken(env, token)).toBeNull();
  });
  it('fresh JWKS for unseen issuer', async () => {
    const env = makeTestEnv({ AUTH_API_URL: 'https://unseen.example' });
    const tokenEnv = makeTestEnv();
    const token = await signTestJwt(tokenEnv, { sub: 'a' });
    expect(await verifySessionToken(env, token)).toBeNull();
  });
});

describe('cookie helpers', () => {
  it('parses cookie', () => {
    expect(readSessionToken(`other=foo; ${SESSION_COOKIE}=abc`)).toBe('abc');
  });
  it('null on missing', () => {
    expect(readSessionToken(null)).toBeNull();
    expect(readSessionToken('')).toBeNull();
    expect(readSessionToken('x=1')).toBeNull();
  });
  it('cookieHeader attrs', () => {
    const h = cookieHeader('tok');
    expect(h).toContain(`${SESSION_COOKIE}=tok`);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('Secure');
    expect(h).toContain('SameSite=Lax');
  });
  it('SESSION_COOKIE is transition_session', () => {
    expect(SESSION_COOKIE).toBe('transition_session');
  });
  it('clearCookieHeader', () => {
    expect(clearCookieHeader()).toContain('Max-Age=0');
  });
});
