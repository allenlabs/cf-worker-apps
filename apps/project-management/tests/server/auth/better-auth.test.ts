import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTestEnv } from '../../_setup/env';
import { primeJwks, resetTestJwt, signTestJwt } from '../../_setup/jwt';
import type { Env } from '~/lib/env';
import { betterAuthAdapter } from '~/server/auth/adapters/better-auth';

let env: Env;

beforeEach(async () => {
  env = makeTestEnv();
  await primeJwks(env);
});
afterEach(() => {
  resetTestJwt();
  vi.unstubAllGlobals();
});

const cookie = (token: string) => `cfr_session=${token}`;

describe('betterAuthAdapter.verify', () => {
  it('returns null with no cookie', async () => {
    expect(await betterAuthAdapter.verify(env, null)).toBeNull();
  });

  it('maps a full JWT payload to a normalized identity', async () => {
    const token = await signTestJwt(env, {
      sub: 'ext-1',
      email: 'a@b.test',
      name: 'Alice A',
      username: 'alice',
      preferredName: 'Al',
      locale: 'ko',
      role: 'admin',
      teamMemberships: [{ teamId: 't1', role: 'owner' }],
    });
    const id = await betterAuthAdapter.verify(env, cookie(token));
    expect(id).toEqual({
      subject: 'ext-1',
      email: 'a@b.test',
      displayName: 'Alice A',
      username: 'alice',
      preferredName: 'Al',
      locale: 'ko',
      isPlatformAdmin: true,
      teamMemberships: [{ teamId: 't1', role: 'owner' }],
    });
  });

  it('fills neutral defaults for a minimal payload', async () => {
    const token = await signTestJwt(env, { sub: 'ext-2' });
    const id = await betterAuthAdapter.verify(env, cookie(token));
    expect(id).toEqual({
      subject: 'ext-2',
      email: '',
      displayName: null,
      username: null,
      preferredName: null,
      locale: null,
      isPlatformAdmin: false,
      teamMemberships: [],
    });
  });

  it('returns null for an unverifiable token', async () => {
    expect(await betterAuthAdapter.verify(env, cookie('not-a-jwt'))).toBeNull();
  });
});

describe('betterAuthAdapter.loginRedirect', () => {
  it('points at the provider sign-in with a return_to callback', () => {
    const { href } = betterAuthAdapter.loginRedirect(env, {});
    const u = new URL(href);
    expect(u.origin + u.pathname).toBe('https://auth.test/sign-in');
    expect(u.searchParams.get('return_to')).toBe('http://localhost:3000/auth/callback');
  });
});

describe('betterAuthAdapter.handleCallback', () => {
  async function fetchReturning(status: number, json: unknown): Promise<typeof fetch> {
    return (async () => new Response(JSON.stringify(json), { status })) as unknown as typeof fetch;
  }

  it('exchanges the code, verifies, and returns identity + token + redirect', async () => {
    const token = await signTestJwt(env, { sub: 'ext-9', email: 'c@d.test' });
    const res = await betterAuthAdapter.handleCallback(
      env,
      new Request('https://pm.test/auth/callback?code=abc&next=/projects'),
      { fetch: await fetchReturning(200, { token }) },
    );
    expect(res.sessionToken).toBe(token);
    expect(res.identity.subject).toBe('ext-9');
    expect(res.redirectTo).toBe('/projects');
  });

  it('defaults redirect to / when next is missing or not a path', async () => {
    const token = await signTestJwt(env, { sub: 'ext-9' });
    const res = await betterAuthAdapter.handleCallback(
      env,
      new Request('https://pm.test/auth/callback?code=abc&next=http://evil'),
      { fetch: await fetchReturning(200, { token }) },
    );
    expect(res.redirectTo).toBe('/');
  });

  it('throws (redirect to login) when no code', async () => {
    let err: unknown;
    try {
      await betterAuthAdapter.handleCallback(env, new Request('https://pm.test/auth/callback'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeTruthy(); // redirect to /auth/login was thrown
  });

  it('throws 400 when the exchange is non-200', async () => {
    let err: unknown;
    try {
      await betterAuthAdapter.handleCallback(env, new Request('https://pm.test/auth/callback?code=x'), {
        fetch: await fetchReturning(403, {}),
      });
    } catch (e) {
      err = e;
    }
    expect((err as Response).status).toBe(400);
  });

  it('throws 500 when no token is returned', async () => {
    let err: unknown;
    try {
      await betterAuthAdapter.handleCallback(env, new Request('https://pm.test/auth/callback?code=x'), {
        fetch: await fetchReturning(200, {}),
      });
    } catch (e) {
      err = e;
    }
    expect((err as Response).status).toBe(500);
  });

  it('throws 500 when the issued token fails verification', async () => {
    let err: unknown;
    try {
      await betterAuthAdapter.handleCallback(env, new Request('https://pm.test/auth/callback?code=x'), {
        fetch: await fetchReturning(200, { token: 'garbage' }),
      });
    } catch (e) {
      err = e;
    }
    expect((err as Response).status).toBe(500);
  });
});

describe('betterAuthAdapter cookies + logout', () => {
  it('session/clear cookie helpers carry the session cookie name', () => {
    expect(betterAuthAdapter.sessionCookie('tok')).toContain('cfr_session=tok');
    expect(betterAuthAdapter.clearSessionCookie()).toContain('cfr_session=');
  });

  it('logout with no cookie still returns the sign-out redirect + clear cookie', async () => {
    const { href, setCookie } = await betterAuthAdapter.logout(env, null);
    expect(href).toBe('https://auth-api.test/api/auth/sign-out');
    expect(setCookie).toContain('Max-Age=0');
  });

  it('logout revokes a present token', async () => {
    const token = await signTestJwt(env, { sub: 'ext-3' });
    const { href } = await betterAuthAdapter.logout(env, cookie(token));
    expect(href).toContain('/api/auth/sign-out');
  });

  it('swallows a revoke failure', async () => {
    const throwingDb = {
      prepare() {
        return { bind() { return this; }, async run() { throw new Error('d1 down'); } };
      },
    } as unknown as D1Database;
    const token = await signTestJwt(env, { sub: 'ext-4' });
    const { setCookie } = await betterAuthAdapter.logout({ ...env, AUTH_DB: throwingDb }, cookie(token));
    expect(setCookie).toContain('Max-Age=0');
  });
});

describe('betterAuthAdapter.onProjectCreated', () => {
  it('returns null teamId when there is no acting external user', async () => {
    const r = await betterAuthAdapter.onProjectCreated!(env, {
      actingExternalUserId: null,
      projectName: 'P',
      projectSlug: 'p',
    });
    expect(r).toEqual({ teamId: null });
  });

  it('provisions a team when the org bridge succeeds', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ teamId: 'team_x', slug: 'p' }), { status: 200 }));
    const r = await betterAuthAdapter.onProjectCreated!(env, {
      actingExternalUserId: 'ext-7',
      projectName: 'P',
      projectSlug: 'p',
    });
    expect(r).toEqual({ teamId: 'team_x' });
  });

  it('falls back to null teamId when the org bridge fails', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 500 }));
    const r = await betterAuthAdapter.onProjectCreated!(env, {
      actingExternalUserId: 'ext-8',
      projectName: 'P',
      projectSlug: 'p',
    });
    expect(r).toEqual({ teamId: null });
  });
});
