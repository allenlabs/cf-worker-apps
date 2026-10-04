import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '@allenlabs/pm-core/lib/env';
import { cookieAttrs } from '@allenlabs/pm-core/server/auth/cookies';

/**
 * Session handling for the post-SSO world.
 *
 * Sign-in itself happens on auth.allen.company (allenlabs-auth-web).  PM
 * never sees the user's password — it only receives a one-time code at
 * /auth/callback, swaps it for an RS256 JWT against auth-api.allen.company,
 * and stores that JWT in `cfr_session`.  Every request thereafter:
 *
 *   1. Read `cfr_session` cookie.
 *   2. Verify the JWT signature against the JWKS published by auth-api
 *      (cached in-process by `createRemoteJWKSet`).
 *   3. Map `sub` (Better Auth user id, a UUID string) to a local users
 *      row via `better_auth_user_id` and return it.
 *
 * Cookie lifetime is bounded by the JWT's `exp` (1h per auth-api config),
 * so an expired cookie means a silent round-trip through /auth/login →
 * auth.allen.company → /auth/callback to refresh.  The auth.allen.company
 * cookie keeps the user signed in there for 7 days, so the refresh is
 * password-less.
 */

export const SESSION_COOKIE = 'cfr_session';
export const SESSION_MAX_AGE_SECONDS = 8 * 60 * 60; // 8h — matches auth-api JWT expiry (extended from 1h).

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
  maxAge: SESSION_MAX_AGE_SECONDS,
};

/** One per-team membership the auth-api JWT carries (PM Phase 2). */
export interface TeamMembershipClaim {
  teamId: string;
  teamName?: string;
  orgId?: string;
  orgSlug?: string;
  role: string; // AC role: owner|admin|maintainer|contributor|commenter|viewer|member
}

/** One org membership the JWT carries. */
export interface OrgMembershipClaim {
  orgId: string;
  orgSlug?: string;
  orgName?: string;
  role: string;
}

export interface SessionPayload extends JWTPayload {
  sub: string;       // Better Auth user id (UUID string)
  email?: string;
  name?: string | null;
  // Suite-wide profile fields (Phase 1). Present from the auth-api JWT.
  username?: string | null;
  preferredName?: string | null;
  role?: string | null; // platform role: 'admin' | 'user'
  banned?: boolean | number | null;
  // Opaque site key (top partition of a single-DB multi-site deployment), if
  // the IdP carries one.
  site?: string | null;
  memberships?: OrgMembershipClaim[];
  // Per-team (= per-project) memberships with the user's role on each team.
  teamMemberships?: TeamMembershipClaim[];
}

// JWKS cache — one entry per JWKS URL, shared across requests within the
// same isolate. `createRemoteJWKSet` handles 5-minute cache + auto-refetch
// on key rotation.
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
 * payload, or null if the token is missing / invalid / expired / revoked.
 */
export async function verifySessionToken(
  env: Env,
  token: string,
): Promise<SessionPayload | null> {
  if (!token) return null;
  try {
    if (await isRevoked(env, token)) return null;
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

export function cookieHeader(env: Env, token: string, maxAge = SESSION_MAX_AGE_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; ${cookieAttrs(env)}; Max-Age=${maxAge}`;
}

export function clearCookieHeader(env: Env): string {
  return `${SESSION_COOKIE}=; ${cookieAttrs(env)}; Max-Age=0`;
}

export function readSessionToken(cookieString: string | null): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

/**
 * Revoke a JWT before its natural expiration by recording its hash in the
 * shared `revoked_sessions` table on the auth D1 (APAC). Useful for
 * /auth/logout — though the auth-api session lives longer, so the user
 * would also need to sign out there for a complete logout. The previous
 * Workers KV-backed implementation moved here so that:
 *   - storage lives next to auth itself (no cross-continent hop on the
 *     hot-path read in verifySessionToken),
 *   - the deploy token no longer needs KV:Edit,
 *   - a single row reflects the suite-wide ban; every web worker queries
 *     the same table.
 */
export async function revokeSession(env: Env, token: string): Promise<void> {
  // AUTH_DB is optional (only the betterAuth path uses revocation). Without it
  // there's no revocation list to write to — the JWT is valid until its `exp`.
  if (!env.AUTH_DB) return;
  const key = await tokenKey(token);
  await env.AUTH_DB.prepare(
    `INSERT INTO revoked_sessions(key, expires_at)
       VALUES (?, unixepoch() + ?)
       ON CONFLICT(key) DO UPDATE SET expires_at = excluded.expires_at`,
  )
    .bind(key, SESSION_MAX_AGE_SECONDS)
    .run();
}

async function isRevoked(env: Env, token: string): Promise<boolean> {
  // No revocation DB bound ⇒ nothing can be revoked (oidc deployments).
  if (!env.AUTH_DB) return false;
  const key = await tokenKey(token);
  // `WHERE expires_at > unixepoch()` ignores rows that would already have
  // aged out, so an unvacuumed expired row doesn't keep a JWT blocked past
  // its natural exp.
  const row = await env.AUTH_DB.prepare(
    `SELECT 1 FROM revoked_sessions WHERE key = ? AND expires_at > unixepoch() LIMIT 1`,
  )
    .bind(key)
    .first();
  return row !== null;
}

async function tokenKey(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  const arr = new Uint8Array(digest);
  let hex = '';
  for (const b of arr) hex += b.toString(16).padStart(2, '0');
  return `revoked:${hex}`;
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
