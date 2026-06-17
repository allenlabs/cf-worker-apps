import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { Env } from '@allenlabs/pm-core/lib/env';
import type { AuthIdentity } from './types';

// PM-owned session token.
//
// An OIDC id_token is a one-time AUTHENTICATION proof, not a rolling session
// credential — its `exp` is short (≈1h on common defaults) and there's no
// renewal, so reusing it as the session logs users out mid-session. Instead, the
// login flow is just the auth event; afterwards PM mints its OWN session token
// (HS256, signed with `PM_SESSION_SECRET`) carrying the minimal claims needed to
// reconstruct the `AuthIdentity` on later requests. Its lifetime is independent
// of the id_token (PM_SESSION_TTL), and it is verified locally — no IdP JWKS / no
// network on the hot path.
//
// Tenant-neutral: the issuer/audience are the constant `pm`; no consumer
// specifics. Org/team/site MEMBERSHIPS are persisted by syncMembershipsImpl at
// login and re-derived from the DB, so they are intentionally NOT embedded here.

const PM_SESSION_ISS = 'pm';
const PM_SESSION_AUD = 'pm';
export const DEFAULT_PM_SESSION_TTL = 8 * 60 * 60; // 8h

function secretKey(env: Env): Uint8Array {
  if (!env.PM_SESSION_SECRET) throw new Error('PM_SESSION_SECRET is not configured.');
  return new TextEncoder().encode(env.PM_SESSION_SECRET);
}

/** Configured session lifetime in seconds (default 8h; invalid/≤0 ⇒ default). */
export function pmSessionTtl(env: Env): number {
  const n = env.PM_SESSION_TTL ? Number(env.PM_SESSION_TTL) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_PM_SESSION_TTL;
}

/** Optional absolute cap in seconds (null ⇒ uncapped; invalid/≤0 ⇒ null). */
export function pmSessionMaxTtl(env: Env): number | null {
  const n = env.PM_SESSION_MAX_TTL ? Number(env.PM_SESSION_MAX_TTL) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function str(payload: JWTPayload, key: string): string | null {
  const v = payload[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Map a verified PM-session payload back to the neutral identity. */
function claimsToIdentity(payload: JWTPayload): AuthIdentity {
  return {
    subject: payload.sub as string,
    email: str(payload, 'email') ?? '',
    displayName: str(payload, 'name'),
    username: str(payload, 'username'),
    preferredName: str(payload, 'preferred_name'),
    locale: str(payload, 'locale'),
    isPlatformAdmin: payload.role === 'admin',
    // Re-derived from the DB (group/site membership), not carried in the token.
    teamMemberships: [],
    site: str(payload, 'site'),
  };
}

/**
 * Mint a PM-owned session JWT for `identity`. Lifetime = PM_SESSION_TTL, capped
 * at PM_SESSION_MAX_TTL when set. `auth_time` records the original login instant
 * (anchor for a future sliding-renewal absolute cap). Throws if no secret.
 */
export async function mintPmSession(
  env: Env,
  identity: AuthIdentity,
  idToken?: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const ttl = pmSessionTtl(env);
  const maxTtl = pmSessionMaxTtl(env);
  const exp = maxTtl != null ? Math.min(now + ttl, now + maxTtl) : now + ttl;
  return new SignJWT({
    email: identity.email || undefined,
    name: identity.displayName ?? undefined,
    username: identity.username ?? undefined,
    preferred_name: identity.preferredName ?? undefined,
    locale: identity.locale ?? undefined,
    role: identity.isPlatformAdmin ? 'admin' : undefined,
    site: identity.site ?? undefined,
    // Original IdP id_token, retained ONLY for RP-initiated logout
    // (id_token_hint). Omitted unless provided.
    idt: idToken || undefined,
    auth_time: now,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(identity.subject)
    .setIssuer(PM_SESSION_ISS)
    .setAudience(PM_SESSION_AUD)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .sign(secretKey(env));
}

/**
 * Verify a PM-owned session JWT (HS256 + iss/aud + exp) and map it back to the
 * identity, or null when missing/invalid/expired/tampered. No IdP JWKS, no
 * network — this is the hot-path session check on every request.
 */
export async function verifyPmSession(env: Env, token: string): Promise<AuthIdentity | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env), {
      issuer: PM_SESSION_ISS,
      audience: PM_SESSION_AUD,
    });
    if (typeof payload.sub !== 'string') return null;
    return claimsToIdentity(payload);
  } catch {
    return null;
  }
}

/**
 * Extract the original IdP `id_token` embedded at login (the `idt` claim) — for
 * RP-initiated logout (`id_token_hint`). Verifies the PM signature + iss/aud but
 * IGNORES expiry (a PM session outlives the short id_token, so at logout the
 * embedded id_token is usually expired; the OP is expected to accept an expired
 * hint per the RP-Initiated Logout spec). Returns null if missing/invalid.
 */
export async function readPmSessionIdToken(env: Env, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(env), {
      issuer: PM_SESSION_ISS,
      audience: PM_SESSION_AUD,
      clockTolerance: Number.MAX_SAFE_INTEGER, // accept an expired PM session — we only want `idt`
    });
    return typeof payload.idt === 'string' && payload.idt ? payload.idt : null;
  } catch {
    return null;
  }
}
