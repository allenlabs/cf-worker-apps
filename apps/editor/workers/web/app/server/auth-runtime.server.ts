// TanStack Start–aware helpers. Split from pure modules so the SSR runtime
// import (`getRequest`) never leaks into the client bundle / unit tests.
//
// The editor-web worker holds NO database — it only reads the JWT and proxies
// document operations to editor-api over HMAC. So "the current user" is purely
// derived from the verified JWT claims (no users.findFirst hop).
/* v8 ignore start */
import { getRequest } from '@tanstack/react-start/server';
import type { Env } from '~/lib/env';
import {
  displayNameOf,
  readSessionToken,
  verifySessionToken,
  type SessionPayload,
} from './session.server';

export interface CurrentUser {
  /** Better Auth user id (JWT `sub`). */
  id: string;
  /** Display name (preferredName → name → username → email-local). */
  name: string;
  username: string | null;
  /** SSO email (Phase 16 — per-user notification identity). Null when absent. */
  email: string | null;
}

export function getEnv(): Env {
  const req = getRequest();
  const env: Env | undefined =
    (req as { cf?: { env?: Env } } | undefined)?.cf?.env ??
    (globalThis as { __env__?: Env }).__env__;
  if (!env) {
    throw new Error('Cloudflare env is not available. Are you running under wrangler/vite-dev?');
  }
  return env;
}

/** Map a verified JWT payload → the lightweight CurrentUser the app needs. */
export function userFromPayload(payload: SessionPayload): CurrentUser {
  return {
    id: payload.sub,
    name: displayNameOf(payload),
    username: typeof payload.username === 'string' ? payload.username : null,
    email: typeof payload.email === 'string' ? payload.email : null,
  };
}

const userCache = new WeakMap<Request, Promise<CurrentUser | null>>();

export function getCurrentUser(): Promise<CurrentUser | null> {
  const req = getRequest();
  const env = getEnv();
  if (!req) return Promise.resolve(null);
  let p = userCache.get(req);
  if (!p) {
    const cookie = req.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    p = token
      ? verifySessionToken(env, token).then((payload) =>
          payload?.sub ? userFromPayload(payload) : null,
        )
      : Promise.resolve(null);
    userCache.set(req, p);
  }
  return p;
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new Error('Unauthorized');
  return u;
}
/* v8 ignore stop */
