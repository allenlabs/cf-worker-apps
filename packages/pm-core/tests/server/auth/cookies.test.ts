import { describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../../src/testing/env';
import { cookieAttrs } from '@allenlabs/pm-core/server/auth/cookies';
import { betterAuthAdapter } from '@allenlabs/pm-core/server/auth/adapters/better-auth';
import { oidcAdapter } from '@allenlabs/pm-core/server/auth/adapters/oidc';

describe('cookieAttrs (configurable SameSite)', () => {
  it('defaults to Lax — byte-identical to the historical attributes', () => {
    expect(cookieAttrs(makeTestEnv())).toBe('HttpOnly; Secure; SameSite=Lax; Path=/');
  });

  it('emits SameSite=None; Secure for embedded deployments', () => {
    const a = cookieAttrs(makeTestEnv({ PM_COOKIE_SAMESITE: 'none' }));
    expect(a).toBe('HttpOnly; Secure; SameSite=None; Path=/');
    expect(a).toContain('Secure'); // None is always paired with Secure
  });

  it('supports Strict', () => {
    expect(cookieAttrs(makeTestEnv({ PM_COOKIE_SAMESITE: 'strict' }))).toBe(
      'HttpOnly; Secure; SameSite=Strict; Path=/',
    );
  });

  it('is case-insensitive and falls back to Lax for an unknown value', () => {
    expect(cookieAttrs(makeTestEnv({ PM_COOKIE_SAMESITE: 'NONE' as never }))).toContain(
      'SameSite=None',
    );
    expect(cookieAttrs(makeTestEnv({ PM_COOKIE_SAMESITE: 'bogus' as never }))).toContain(
      'SameSite=Lax',
    );
  });

  it('appends ; Partitioned only with SameSite=None', () => {
    expect(cookieAttrs(makeTestEnv({ PM_COOKIE_SAMESITE: 'none', PM_COOKIE_PARTITIONED: '1' }))).toBe(
      'HttpOnly; Secure; SameSite=None; Path=/; Partitioned',
    );
    expect(
      cookieAttrs(makeTestEnv({ PM_COOKIE_SAMESITE: 'none', PM_COOKIE_PARTITIONED: 'true' })),
    ).toContain('; Partitioned');
    // Ignored when not None.
    expect(cookieAttrs(makeTestEnv({ PM_COOKIE_PARTITIONED: '1' }))).not.toContain('Partitioned');
    // Ignored for an unrecognized truthy-ish value.
    expect(
      cookieAttrs(makeTestEnv({ PM_COOKIE_SAMESITE: 'none', PM_COOKIE_PARTITIONED: 'yes' })),
    ).not.toContain('Partitioned');
  });
});

describe('adapter cookies honour the SameSite knob', () => {
  const none = makeTestEnv({ PM_COOKIE_SAMESITE: 'none', PM_COOKIE_PARTITIONED: '1' });
  const lax = makeTestEnv();

  it('betterAuth session + clear cookies match attributes (so clear actually clears)', () => {
    expect(betterAuthAdapter.sessionCookie(lax, 'tok')).toBe(
      'cfr_session=tok; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=28800',
    );
    expect(betterAuthAdapter.sessionCookie(none, 'tok')).toBe(
      'cfr_session=tok; HttpOnly; Secure; SameSite=None; Path=/; Partitioned; Max-Age=28800',
    );
    expect(betterAuthAdapter.clearSessionCookie(none)).toBe(
      'cfr_session=; HttpOnly; Secure; SameSite=None; Path=/; Partitioned; Max-Age=0',
    );
  });

  it('oidc session + state + clear cookies carry the configured attributes', () => {
    expect(oidcAdapter.sessionCookie(none, 'tok')).toBe(
      'pm_session=tok; HttpOnly; Secure; SameSite=None; Path=/; Partitioned; Max-Age=28800',
    );
    expect(oidcAdapter.clearSessionCookie(none)).toBe(
      'pm_session=; HttpOnly; Secure; SameSite=None; Path=/; Partitioned; Max-Age=0',
    );
    // default stays Lax
    expect(oidcAdapter.sessionCookie(lax, 'tok')).toContain('SameSite=Lax');
  });

  it('the oidc state cookie (login round-trip) also picks up SameSite=None', async () => {
    const e = makeTestEnv({
      PM_COOKIE_SAMESITE: 'none',
      PM_COOKIE_PARTITIONED: '1',
      AUTH_ADAPTER: 'oidc',
      OIDC_ISSUER: 'https://idp.test',
      OIDC_CLIENT_ID: 'client-x',
    });
    // Prime discovery so loginRedirect doesn't hit the network.
    const { _setOidcDiscoveryForTests, _clearOidcCachesForTests } = await import(
      '@allenlabs/pm-core/server/auth/adapters/oidc'
    );
    _clearOidcCachesForTests();
    _setOidcDiscoveryForTests('https://idp.test', {
      issuer: 'https://idp.test',
      authorization_endpoint: 'https://idp.test/authorize',
      token_endpoint: 'https://idp.test/token',
      jwks_uri: 'https://idp.test/jwks',
    });
    const { setCookie } = await oidcAdapter.loginRedirect(e, {});
    expect(setCookie).toContain('pm_oidc_state=');
    expect(setCookie).toContain('SameSite=None');
    expect(setCookie).toContain('Partitioned');
    expect(setCookie).toContain('Max-Age=600');
    _clearOidcCachesForTests();
  });

  it('the betterAuth logout clear cookie also matches the configured attributes', async () => {
    const { setCookie } = await betterAuthAdapter.logout(none, null);
    expect(setCookie).toBe(
      'cfr_session=; HttpOnly; Secure; SameSite=None; Path=/; Partitioned; Max-Age=0',
    );
  });
});
