import { beforeEach, describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../src/testing/env';
import { primeJwks, signTestJwt } from '../../src/testing/jwt';
import {
  SESSION_COOKIE,
  clearCookieHeader,
  cookieHeader,
  readSessionToken,
  revokeSession,
  verifySessionToken,
} from '@allenlabs/pm-core/server/session.server';

describe('verifySessionToken (RS256 / JWKS)', () => {
  beforeEach(async () => {
    await primeJwks(makeTestEnv());
  });

  it('round-trips a payload signed against the JWKS', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, {
      sub: 'better-auth-user-1',
      email: 'alice@example.test',
      name: 'Alice',
    });
    const payload = await verifySessionToken(env, token);
    expect(payload).not.toBeNull();
    expect(payload!.sub).toBe('better-auth-user-1');
    expect(payload!.email).toBe('alice@example.test');
  });

  it('rejects an empty token', async () => {
    expect(await verifySessionToken(makeTestEnv(), '')).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' });
    // Flip a byte in the payload segment (middle of the JWT, between the
    // two dots).  Tweaking the signature tail can land in encoding slack
    // and slip past verification.
    const [h, p, s] = token.split('.');
    const flipped = p![5] === 'A' ? 'B' : 'A';
    const mungedPayload = p!.slice(0, 5) + flipped + p!.slice(6);
    expect(await verifySessionToken(env, `${h}.${mungedPayload}.${s}`)).toBeNull();
  });

  it('rejects a token issued for a different audience/issuer', async () => {
    const realEnv = makeTestEnv();
    const wrongEnv = makeTestEnv({ AUTH_API_URL: 'https://other.test' });
    const token = await signTestJwt(realEnv, { sub: 'a' });
    expect(await verifySessionToken(wrongEnv, token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' }, { expSecondsFromNow: -10 });
    expect(await verifySessionToken(env, token)).toBeNull();
  });

  it('returns null when AUTH_API_URL is unset', async () => {
    const env = makeTestEnv({ AUTH_API_URL: '' });
    expect(await verifySessionToken(env, 'any')).toBeNull();
  });

  it('returns null when the JWT verifies but `sub` is not a string', async () => {
    // jose lets us craft a payload with a non-string `sub` — the
    // signature still verifies but our guard in verifySessionToken should
    // reject it before the caller can dereference `sub`.  We prime the
    // JWKS cache with a fresh ephemeral key so the token verifies.
    const env = makeTestEnv();
    const { SignJWT, generateKeyPair, exportJWK, createLocalJWKSet } = await import('jose');
    const { _setJwksForTests } = await import('@allenlabs/pm-core/server/session.server');
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'numeric-sub-kid';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks = createLocalJWKSet({ keys: [publicJwk as any] });
    _setJwksForTests(env.AUTH_API_URL, jwks as any);
    const tokenWithNumericSub = await new SignJWT({ sub: 42 as unknown as string })
      .setProtectedHeader({ alg: 'RS256', kid: 'numeric-sub-kid' })
      .setIssuer(env.AUTH_API_URL)
      .setAudience(env.AUTH_API_URL)
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(privateKey);
    expect(await verifySessionToken(env, tokenWithNumericSub)).toBeNull();
    // Restore the original test JWKS for any later tests in this file.
    await primeJwks(env);
  });

  it('logs and returns null when verification throws a non-Error value', async () => {
    // The catch's `console.error` uses a ternary that has a non-Error
    // branch: `err instanceof Error ? ... : String(err)`.  Force jwtVerify
    // to throw a bare string so that branch runs.
    const env = makeTestEnv();
    const { _setJwksForTests } = await import('@allenlabs/pm-core/server/session.server');
    // A JWKS callable that throws a string — non-Error throw values are
    // rare but legal and our catch must handle them.
    _setJwksForTests(env.AUTH_API_URL, (() => {
      throw 'opaque-non-error-failure';
    }) as never);
    const dummyToken = 'eyJhbGciOiJSUzI1NiJ9.e30.sig';
    expect(await verifySessionToken(env, dummyToken)).toBeNull();
    // Restore the original test JWKS for any later tests in this file.
    await primeJwks(env);
  });
});

describe('revokeSession', () => {
  beforeEach(async () => {
    await primeJwks(makeTestEnv());
  });

  it('causes a previously-valid token to be rejected', async () => {
    const env = makeTestEnv();
    const token = await signTestJwt(env, { sub: 'a' });
    expect(await verifySessionToken(env, token)).not.toBeNull();
    await revokeSession(env, token);
    expect(await verifySessionToken(env, token)).toBeNull();
  });
});

describe('cookie helpers', () => {
  it('cookieHeader produces a Secure HttpOnly Lax cookie', () => {
    const h = cookieHeader('xyz');
    expect(h).toContain(`${SESSION_COOKIE}=xyz`);
    expect(h).toContain('HttpOnly');
    expect(h).toContain('Secure');
    expect(h).toContain('SameSite=Lax');
    expect(h).toContain('Path=/');
    expect(h).toMatch(/Max-Age=\d+/);
  });

  it('cookieHeader honours a custom max-age', () => {
    expect(cookieHeader('xyz', 120)).toContain('Max-Age=120');
  });

  it('clearCookieHeader emits Max-Age=0', () => {
    expect(clearCookieHeader()).toContain('Max-Age=0');
  });

  it('readSessionToken extracts the token, ignoring other cookies', () => {
    expect(readSessionToken(`foo=bar; ${SESSION_COOKIE}=tok; baz=qux`)).toBe('tok');
  });

  it('readSessionToken returns null when the cookie is absent', () => {
    expect(readSessionToken('foo=bar')).toBeNull();
  });

  it('readSessionToken returns null on a null cookie string', () => {
    expect(readSessionToken(null)).toBeNull();
  });

  it('readSessionToken handles values containing `=`', () => {
    expect(readSessionToken(`${SESSION_COOKIE}=eyJ=foo=bar`)).toBe('eyJ=foo=bar');
  });
});
