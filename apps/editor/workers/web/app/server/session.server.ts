import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '~/lib/env';

/**
 * Session handling for the post-SSO world (adapted from project-management).
 *
 * Sign-in happens on auth.allen.company (allenlabs-auth-web). Editor never
 * sees the password — it receives a one-time code at /auth/callback, swaps it
 * for an RS256 JWT against auth-api.allen.company, and stores that JWT in the
 * `editor_session` cookie. Every request thereafter:
 *
 *   1. Read `editor_session` cookie.
 *   2. Verify the JWT signature against the JWKS published by auth-api
 *      (cached in-process by `createRemoteJWKSet`).
 *   3. Trust the claims (sub, name, username, …).
 *
 * v1 deliberately DROPS the suite-wide revocation check (no D1 binding) — a
 * logout clears the local cookie and bounces through auth-api sign-out; an
 * unexpired JWT keeps working until its natural exp (≤ 8h). Add the AUTH_DB
 * revocation path later if instant suite-wide kill is needed.
 */

export const SESSION_COOKIE = 'editor_session';
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8h — matches auth-api JWT expiry.

export interface SessionPayload extends JWTPayload {
  sub: string; // Better Auth user id (UUID string)
  email?: string;
  name?: string | null;
  username?: string | null;
  preferredName?: string | null;
  locale?: string | null;
}

// JWKS cache — one entry per JWKS URL, shared across requests within the same
// isolate. `createRemoteJWKSet` handles 5-minute cache + auto-refetch.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(env: Env): ReturnType<typeof createRemoteJWKSet> {
  const base = env.AUTH_API_URL;
  if (!base) {
    throw new Error('AUTH_API_URL is not configured.');
  }
  const url = `${base.replace(/\/$/, '')}/.well-known/jwks.json`;
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

/**
 * Verify a session token (the RS256 JWT minted by auth-api) and return its
 * payload, or null if the token is missing / invalid / expired.
 */
export async function verifySessionToken(
  env: Env,
  token: string,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    const jwks = getJwks(env);
    const { payload } = await jwtVerify(token, jwks, {
      issuer: env.AUTH_API_URL,
      audience: env.AUTH_API_URL,
    });
    if (typeof payload.sub !== 'string') return null;
    return payload as SessionPayload;
  } catch (err) {
    console.error('[verifySessionToken] failed:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    return null;
  }
}

/** Suite-wide display convention: preferredName → name → username → email-local. */
export function displayNameOf(payload: SessionPayload): string {
  return (
    (typeof payload.preferredName === 'string' && payload.preferredName) ||
    (typeof payload.name === 'string' && payload.name) ||
    (typeof payload.username === 'string' && payload.username) ||
    (typeof payload.email === 'string' && payload.email.split('@')[0]) ||
    'user'
  );
}

export function cookieHeader(token: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

export function readSessionToken(cookieString: string | null): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

// Exposed for tests so they can pre-seed the JWKS cache with a static
// in-memory key set instead of fetching the real /.well-known/jwks.json.
export function _setJwksForTests(
  authApiUrl: string,
  jwks: ReturnType<typeof createRemoteJWKSet>,
): void {
  const url = `${authApiUrl.replace(/\/$/, '')}/.well-known/jwks.json`;
  jwksCache.set(url, jwks);
}

export function _clearJwksCacheForTests(): void {
  jwksCache.clear();
}
