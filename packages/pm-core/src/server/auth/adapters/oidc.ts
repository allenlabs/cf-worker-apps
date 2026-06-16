// Generic OpenID Connect adapter — standard Authorization Code + PKCE against
// ANY conformant OIDC provider, by configuration only. Everything
// provider-specific (endpoints, JWKS location, signing algorithm, issuer) is
// resolved from the discovery document; nothing is hardcoded. Selected with
// AUTH_ADAPTER=oidc.
//
// Tenant-neutral: this file contains no deployment/provider names, hostnames,
// JWKS paths, audiences, claim names, or algorithms — all of those come from
// discovery or env (OIDC_* in lib/env.ts).

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '@allenlabs/pm-core/lib/env';
import { cookieAttrs } from '@allenlabs/pm-core/server/auth/cookies';
import type { AuthAdapter, AuthIdentity } from '../types';

// ── discovery + JWKS caches (per isolate) ──────────────────────────────────

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

const discoveryCache = new Map<string, OidcDiscovery>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function requireConfig(env: Env): { issuer: string; clientId: string } {
  if (!env.OIDC_ISSUER) throw new Error('OIDC_ISSUER is not configured.');
  if (!env.OIDC_CLIENT_ID) throw new Error('OIDC_CLIENT_ID is not configured.');
  return { issuer: env.OIDC_ISSUER, clientId: env.OIDC_CLIENT_ID };
}

/** Fetch + cache the provider's discovery document. Never hardcodes endpoints. */
async function discover(env: Env, fetchFn: typeof fetch): Promise<OidcDiscovery> {
  const { issuer } = requireConfig(env);
  const cached = discoveryCache.get(issuer);
  if (cached) return cached;
  const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status}) for ${url}`);
  const doc = (await res.json()) as OidcDiscovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) {
    throw new Error('OIDC discovery document is missing required fields.');
  }
  discoveryCache.set(issuer, doc);
  return doc;
}

function getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

// ── small crypto / encoding helpers (Workers-native) ───────────────────────

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(byteLen = 32): string {
  const bytes = new Uint8Array(byteLen);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

// ── session + state cookies ────────────────────────────────────────────────

// Fixed cookie NAME (like betterAuth's `cfr_session`): the read side (verify)
// and the write side must agree on a constant. The cookie's *attributes* are
// env-driven via cookieAttrs(env) (SameSite policy for embedded deployments).
const SESSION_COOKIE = 'pm_session';
const SESSION_MAX_AGE = 8 * 60 * 60; // 8h; verification still bounded by id_token exp.
const STATE_COOKIE = 'pm_oidc_state';
const STATE_MAX_AGE = 600; // 10 min — the login→callback round-trip window.
const DEFAULT_SCOPES = 'openid profile email';

function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

interface OidcState {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
}

function encodeState(s: OidcState): string {
  return base64url(new TextEncoder().encode(JSON.stringify(s)));
}

function decodeState(value: string | null): OidcState | null {
  if (!value) return null;
  try {
    const json = value.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(json);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as OidcState;
    if (!parsed.state || !parsed.nonce || !parsed.verifier) return null;
    return parsed;
  } catch {
    return null;
  }
}

// The state cookie is HttpOnly+Secure (and SameSite per PM_COOKIE_SAMESITE), so
// it cannot be read or forged by script; CSRF protection comes from the `state`
// echo matching the cookie, replay protection from the `nonce`, and code
// protection from PKCE. In an embedded (iframe) flow the OAuth round-trip is
// cross-origin within the frame, so it needs SameSite=None too — hence env.
function stateCookie(env: Env, value: string): string {
  return `${STATE_COOKIE}=${value}; ${cookieAttrs(env)}; Max-Age=${STATE_MAX_AGE}`;
}

// ── claim mapping (standard OIDC claims, with env overrides) ────────────────

function str(payload: JWTPayload, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function toIdentity(env: Env, payload: JWTPayload): AuthIdentity {
  const roleClaim = env.OIDC_CLAIM_ROLE || 'role';
  const usernameClaim = env.OIDC_CLAIM_USERNAME || 'preferred_username';
  const nameClaim = env.OIDC_CLAIM_NAME || 'name';
  const emailClaim = env.OIDC_CLAIM_EMAIL || 'email';
  const preferredClaim = env.OIDC_CLAIM_PREFERRED || 'name';
  return {
    subject: payload.sub as string,
    email: str(payload, emailClaim) ?? '',
    displayName: str(payload, nameClaim),
    username: str(payload, usernameClaim),
    preferredName: str(payload, preferredClaim) ?? str(payload, 'preferred_username'),
    locale: str(payload, 'locale'),
    // Advisory only — PM admin is still the local users.admin column. Absent
    // role ⇒ not admin (default 'user'); providers without a role claim work.
    isPlatformAdmin: payload[roleClaim] === 'admin',
    // Plain OIDC carries no team/org claim ⇒ empty; PM falls back to pm.members.
    teamMemberships: [],
    // Opaque site key from a configurable claim (default unset ⇒ siteless).
    site: env.OIDC_CLAIM_SITE ? str(payload, env.OIDC_CLAIM_SITE) : null,
  };
}

/** Verify an id_token's signature (JWKS-driven alg — no pinning) + iss/aud. */
async function verifyIdToken(
  env: Env,
  doc: OidcDiscovery,
  token: string,
): Promise<JWTPayload> {
  const { clientId } = requireConfig(env);
  const { payload } = await jwtVerify(token, getJwks(doc.jwks_uri), {
    issuer: doc.issuer,
    audience: clientId,
  });
  if (typeof payload.sub !== 'string') {
    throw new Error('id_token has no string `sub` claim.');
  }
  return payload;
}

function redirectUri(env: Env): string {
  return new URL('/auth/callback', env.PUBLIC_BASE_URL).href;
}

// ── the adapter ────────────────────────────────────────────────────────────

export const oidcAdapter: AuthAdapter = {
  id: 'oidc',

  async verify(env, cookie) {
    const token = readCookie(cookie, SESSION_COOKIE);
    if (!token) return null;
    try {
      const doc = await discover(env, fetch);
      return toIdentity(env, await verifyIdToken(env, doc, token));
    } catch {
      return null;
    }
  },

  async loginRedirect(env, opts) {
    const { clientId } = requireConfig(env);
    const doc = await discover(env, fetch);
    const verifier = randomToken(32);
    const challenge = await pkceChallenge(verifier);
    const state = randomToken(16);
    const nonce = randomToken(16);
    const next = opts.next && opts.next.startsWith('/') ? opts.next : '/';

    const authUrl = new URL(doc.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri(env));
    authUrl.searchParams.set('scope', env.OIDC_SCOPES || DEFAULT_SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('nonce', nonce);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return {
      href: authUrl.href,
      setCookie: stateCookie(env, encodeState({ state, nonce, verifier, next })),
    };
  },

  async handleCallback(env, request, deps) {
    const fetchFn = deps?.fetch ?? fetch;
    const { clientId } = requireConfig(env);
    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const returnedState = url.searchParams.get('state');
    const saved = decodeState(readCookie(request.headers.get('cookie'), STATE_COOKIE));

    if (!code || !returnedState || !saved || returnedState !== saved.state) {
      throw new Response('Invalid OIDC callback (state mismatch).', { status: 400 });
    }

    const doc = await discover(env, fetchFn);
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(env),
      client_id: clientId,
      code_verifier: saved.verifier,
    });
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    // Confidential client ⇒ HTTP Basic auth; public client ⇒ PKCE only.
    if (env.OIDC_CLIENT_SECRET) {
      headers.authorization = `Basic ${btoa(`${clientId}:${env.OIDC_CLIENT_SECRET}`)}`;
    }

    const tokenRes = await fetchFn(doc.token_endpoint, { method: 'POST', headers, body });
    if (!tokenRes.ok) {
      throw new Response('OIDC token exchange failed.', { status: 400 });
    }
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) {
      throw new Response('OIDC token response had no id_token.', { status: 500 });
    }

    let payload: JWTPayload;
    try {
      payload = await verifyIdToken(env, doc, tokens.id_token);
    } catch {
      throw new Response('OIDC id_token failed verification.', { status: 500 });
    }
    if (payload.nonce !== saved.nonce) {
      throw new Response('OIDC nonce mismatch.', { status: 400 });
    }

    return {
      identity: toIdentity(env, payload),
      sessionToken: tokens.id_token,
      redirectTo: saved.next,
    };
  },

  sessionCookie(env, token) {
    return `${SESSION_COOKIE}=${token}; ${cookieAttrs(env)}; Max-Age=${SESSION_MAX_AGE}`;
  },
  clearSessionCookie(env) {
    return `${SESSION_COOKIE}=; ${cookieAttrs(env)}; Max-Age=0`;
  },

  async logout(env, cookie) {
    const clear = `${SESSION_COOKIE}=; ${cookieAttrs(env)}; Max-Age=0`;
    // If the provider advertises RP-initiated logout, send the browser there
    // (with id_token_hint + post_logout_redirect_uri); otherwise just go home.
    let href = env.PUBLIC_BASE_URL;
    try {
      const doc = await discover(env, fetch);
      if (doc.end_session_endpoint) {
        const end = new URL(doc.end_session_endpoint);
        const token = readCookie(cookie, SESSION_COOKIE);
        if (token) end.searchParams.set('id_token_hint', token);
        end.searchParams.set('post_logout_redirect_uri', env.PUBLIC_BASE_URL);
        href = end.href;
      }
    } catch {
      // Discovery unavailable at logout ⇒ best-effort local clear + home.
    }
    return { href, setCookie: clear };
  },

  async onProjectCreated(_env, _ctx) {
    // Plain OIDC has no org/team bridge — PM uses local pm.members RBAC.
    return { teamId: null };
  },
};

// ── test seams (mirror session.server's _setJwksForTests) ──────────────────

export function _setOidcDiscoveryForTests(issuer: string, doc: OidcDiscovery): void {
  discoveryCache.set(issuer, doc);
}
export function _setOidcJwksForTests(
  jwksUri: string,
  jwks: ReturnType<typeof createRemoteJWKSet>,
): void {
  jwksCache.set(jwksUri, jwks);
}
export function _clearOidcCachesForTests(): void {
  discoveryCache.clear();
  jwksCache.clear();
}
