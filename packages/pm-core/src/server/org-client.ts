// HMAC-signed client for the auth-api org/team bridge (PM Phase 2).
//
// PM maps each project to a Better Auth *team* inside org `allenlabs`. The
// team membership + role is the per-project collaborator model. Better Auth's
// org/team mutations require an authenticated caller, and PM only holds the
// user's RS256 JWT (not a Better Auth session cookie), so PM calls the
// HMAC-authenticated /sso/org/* endpoints on auth-api with the acting user's
// Better Auth id (`betterAuthUserId`).
//
// The signing scheme mirrors the notion-gateway client + the ADHD suite:
//   X-Client-Id   env.PM_ORG_HMAC_CLIENT_ID  (e.g. "pm")
//   X-Timestamp   ms-since-epoch
//   X-Signature   base64( HMAC-SHA256( `${ts}\n${body}`, env.PM_ORG_HMAC_SECRET ) )
//
// Lives under app/server/ so the secret never reaches the client bundle.

import type { Env } from '@allenlabs/pm-core/lib/env';

const enc = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/** Build the X-Signature header for a `${ts}\n${body}` payload. */
export async function signOrg(secret: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}\n${body}`));
  return bytesToBase64(new Uint8Array(sig));
}

export interface OrgClientDeps {
  fetcher?: typeof fetch;
  now?: () => number;
}

type OrgEnv = Pick<Env, 'AUTH_API_URL' | 'PM_ORG_HMAC_CLIENT_ID' | 'PM_ORG_HMAC_SECRET'>;

/**
 * Signed request helper. GET requests sign over an empty body (the auth side
 * verifies the same), query params ride on the URL. Throws an Error whose
 * message includes the status + truncated body on non-2xx so callers can
 * surface a useful toast.
 */
export async function signedRequest<T>(
  env: OrgEnv,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  deps: OrgClientDeps = {},
): Promise<T> {
  const ts = (deps.now ?? Date.now)();
  const rawBody = method === 'GET' ? '' : JSON.stringify(body ?? {});
  const sig = await signOrg(env.PM_ORG_HMAC_SECRET, ts, rawBody);
  const base = env.AUTH_API_URL.replace(/\/$/, '');
  /* v8 ignore next — real fetch is the production default; tests inject one. */
  const fetcher = deps.fetcher ?? fetch;
  const headers: Record<string, string> = {
    'X-Client-Id': env.PM_ORG_HMAC_CLIENT_ID,
    'X-Timestamp': String(ts),
    'X-Signature': sig,
  };
  if (method === 'POST') headers['Content-Type'] = 'application/json';
  const res = await fetcher(`${base}${path}`, {
    method,
    headers,
    body: method === 'GET' ? undefined : rawBody,
  });
  if (!res.ok) {
    /* v8 ignore next — res.text() only rejects on malformed bodies. */
    const text = await res.text().catch(() => '');
    throw new Error(`auth-api ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ---------- High-level helpers (one per /sso/org endpoint) ----------

export function createTeam(
  env: OrgEnv,
  args: { actingUserId: string; name: string; slug?: string },
  deps?: OrgClientDeps,
): Promise<{ teamId: string; slug: string }> {
  return signedRequest(env, 'POST', '/sso/org/create-team', args, deps);
}

export function inviteMember(
  env: OrgEnv,
  args: { actingUserId: string; teamId: string; email: string; role: string },
  deps?: OrgClientDeps,
): Promise<{ ok: true; invitationId: string | null; via: string }> {
  return signedRequest(env, 'POST', '/sso/org/invite', args, deps);
}

export function setMemberRole(
  env: OrgEnv,
  args: { actingUserId: string; teamId: string; targetUserId?: string; email?: string; role: string },
  deps?: OrgClientDeps,
): Promise<{ ok: true; userId: string; role: string }> {
  return signedRequest(env, 'POST', '/sso/org/set-member-role', args, deps);
}

export function removeMember(
  env: OrgEnv,
  args: { actingUserId: string; teamId: string; targetUserId?: string; email?: string },
  deps?: OrgClientDeps,
): Promise<{ ok: true; userId: string }> {
  return signedRequest(env, 'POST', '/sso/org/remove-member', args, deps);
}

export interface TeamMember {
  userId: string;
  email: string;
  name: string | null;
  username: string | null;
  preferredName: string | null;
  role: string;
}

export interface TeamInvitation {
  id: string;
  email: string;
  role: string | null;
  status: string;
  expiresAt: string;
}

export function listTeamMembers(
  env: OrgEnv,
  teamId: string,
  deps?: OrgClientDeps,
): Promise<{ members: TeamMember[]; invitations: TeamInvitation[] }> {
  return signedRequest(
    env,
    'GET',
    `/sso/org/team-members?teamId=${encodeURIComponent(teamId)}`,
    undefined,
    deps,
  );
}
