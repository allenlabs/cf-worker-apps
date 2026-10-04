// SSO session verification.  Same pattern as PM: read `cfr_session`
// cookie, verify its RS256 JWT against the JWKS published by
// auth-api.allen.company, return the payload.
//
// We don't persist sessions locally — the gateway has no user table.
// Authorization is granted to anyone the auth tier issued a JWT for;
// finer-grained role checks happen in `requireAdmin` once we have a
// user-role concept.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '../lib/env';

export const SESSION_COOKIE = 'cfr_session';

export interface SessionPayload extends JWTPayload {
  sub: string;
  email?: string;
  name?: string | null;
  role?: string | null;
}

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(env: Env): ReturnType<typeof createRemoteJWKSet> {
  const base = env.AUTH_API_URL;
  if (!base) throw new Error('AUTH_API_URL is not configured.');
  const url = `${base.replace(/\/$/, '')}/.well-known/jwks.json`;
  let jwks = jwksCache.get(url);
  /* v8 ignore next 4 — cache-miss path hits the real `/.well-known/jwks.json`;
     unit tests pre-seed the cache via `_setJwksForTests` to stay hermetic. */
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, jwks);
  }
  return jwks;
}

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
  } catch {
    return null;
  }
}

export function readSessionToken(cookieString: string | null): string | null {
  if (!cookieString) return null;
  for (const part of cookieString.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return rest.join('=');
  }
  return null;
}

export function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
}

export function clearCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

// Test seam — wrangler integration tests pre-seed an in-memory JWKS so
// they don't have to mock /.well-known/jwks.json over HTTP.
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
