import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import { makeTestEnv } from '../../../src/testing/env';
import type { Env } from '@allenlabs/pm-core/lib/env';
import type { AuthIdentity } from '@allenlabs/pm-core/server/auth/types';
import {
  DEFAULT_PM_SESSION_TTL,
  mintPmSession,
  pmSessionMaxTtl,
  pmSessionTtl,
  verifyPmSession,
} from '@allenlabs/pm-core/server/auth/pm-session';

const SECRET = 'pm-session-test-secret-key-0123456789';
const env = (over: Partial<Env> = {}) => makeTestEnv({ PM_SESSION_SECRET: SECRET, ...over });
const key = new TextEncoder().encode(SECRET);

const identity = (over: Partial<AuthIdentity> = {}): AuthIdentity => ({
  subject: 'u-1',
  email: 'u@x.test',
  displayName: 'U One',
  username: 'uone',
  preferredName: 'U',
  locale: 'en',
  isPlatformAdmin: false,
  teamMemberships: [],
  site: null,
  ...over,
});

afterEach(() => vi.useRealTimers());

describe('pmSessionTtl / pmSessionMaxTtl', () => {
  it('defaults the TTL and parses a valid override', () => {
    expect(pmSessionTtl(env())).toBe(DEFAULT_PM_SESSION_TTL);
    expect(pmSessionTtl(env({ PM_SESSION_TTL: '3600' }))).toBe(3600);
  });
  it('falls back to the default for a non-numeric or non-positive TTL', () => {
    expect(pmSessionTtl(env({ PM_SESSION_TTL: 'abc' }))).toBe(DEFAULT_PM_SESSION_TTL); // NaN
    expect(pmSessionTtl(env({ PM_SESSION_TTL: '0' }))).toBe(DEFAULT_PM_SESSION_TTL); // ≤0
  });
  it('parses the absolute max cap (null when unset/invalid)', () => {
    expect(pmSessionMaxTtl(env())).toBeNull();
    expect(pmSessionMaxTtl(env({ PM_SESSION_MAX_TTL: '7200' }))).toBe(7200);
    expect(pmSessionMaxTtl(env({ PM_SESSION_MAX_TTL: '-1' }))).toBeNull();
  });
});

describe('mintPmSession + verifyPmSession', () => {
  it('round-trips the full identity claims', async () => {
    const t = await mintPmSession(env(), identity({ isPlatformAdmin: true, site: 'acme' }));
    expect(await verifyPmSession(env(), t)).toEqual({
      subject: 'u-1',
      email: 'u@x.test',
      displayName: 'U One',
      username: 'uone',
      preferredName: 'U',
      locale: 'en',
      isPlatformAdmin: true,
      teamMemberships: [],
      site: 'acme',
    });
  });

  it('maps a minimal identity with safe defaults', async () => {
    const t = await mintPmSession(
      env(),
      identity({ email: '', displayName: null, username: null, preferredName: null, locale: null }),
    );
    expect(await verifyPmSession(env(), t)).toEqual({
      subject: 'u-1',
      email: '',
      displayName: null,
      username: null,
      preferredName: null,
      locale: null,
      isPlatformAdmin: false,
      teamMemberships: [],
      site: null,
    });
  });

  it('treats an empty-string claim as absent', async () => {
    const t = await new SignJWT({ name: '', site: '' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('u-9')
      .setIssuer('pm')
      .setAudience('pm')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    const id = await verifyPmSession(env(), t);
    expect(id?.displayName).toBeNull();
    expect(id?.site).toBeNull();
  });

  it('rejects a tampered token', async () => {
    const t = await mintPmSession(env(), identity());
    expect(await verifyPmSession(env(), `${t.slice(0, -3)}xxx`)).toBeNull();
  });

  it('rejects a token signed with a different secret', async () => {
    const other = env({ PM_SESSION_SECRET: 'a-totally-different-secret-key-9999999' });
    const t = await mintPmSession(other, identity());
    expect(await verifyPmSession(env(), t)).toBeNull();
  });

  it('returns null for a (well-signed) token with no subject', async () => {
    const t = await new SignJWT({ email: 'x@y.test' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('pm')
      .setAudience('pm')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key);
    expect(await verifyPmSession(env(), t)).toBeNull();
  });

  it('throws when minting without a configured secret', async () => {
    await expect(mintPmSession(makeTestEnv(), identity())).rejects.toThrow(/PM_SESSION_SECRET/);
  });
});

describe('lifetime is decoupled from the id_token exp', () => {
  it('survives well past a short (≈1h) id_token exp, until PM_SESSION_TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00Z'));
    const t = await mintPmSession(env({ PM_SESSION_TTL: '28800' }), identity()); // 8h
    vi.setSystemTime(new Date('2026-06-16T02:00:00Z')); // 2h later — id_token would be dead
    expect(await verifyPmSession(env(), t)).not.toBeNull();
  });

  it('expires after PM_SESSION_TTL ⇒ null (re-login)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00Z'));
    const t = await mintPmSession(env({ PM_SESSION_TTL: '3600' }), identity()); // 1h
    vi.setSystemTime(new Date('2026-06-16T01:00:05Z')); // just past 1h
    expect(await verifyPmSession(env(), t)).toBeNull();
  });

  it('honors the absolute max cap when it is shorter than the TTL', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-16T00:00:00Z'));
    const e = env({ PM_SESSION_TTL: '28800', PM_SESSION_MAX_TTL: '3600' }); // cap 1h < 8h TTL
    const t = await mintPmSession(e, identity());
    vi.setSystemTime(new Date('2026-06-16T01:00:05Z'));
    expect(await verifyPmSession(e, t)).toBeNull(); // capped at 1h
  });
});
