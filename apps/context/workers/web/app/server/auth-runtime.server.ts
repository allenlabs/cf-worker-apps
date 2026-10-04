// TanStack Start–aware helpers.  Verbatim port of focus / inbox
// auth-runtime.server.ts — context is single-tenant per user too.
//
// Coverage for this file comes via deploy smoke tests, not unit tests
// (it depends on the TanStack Start SSR runtime).
/* v8 ignore start */
import { getRequest } from '@tanstack/react-start/server';
import { type DB, makeDb } from '~/db/client';
import type { Env } from '~/lib/env';
import {
  readSessionToken,
  verifySessionToken,
} from './session.server';
import { findUserBySsoImpl, type AppUser } from './users';

export function getEnv(): Env {
  const req = getRequest();
  const env: Env | undefined =
    (req as { cf?: { env?: Env } } | undefined)?.cf?.env ??
    (globalThis as { __env__?: Env }).__env__;
  if (!env) {
    throw new Error('Cloudflare env is not available.  Are you running under wrangler/vinxi-dev?');
  }
  return env;
}

export function getDb(env: Env = getEnv()): DB {
  return makeDb(env);
}

// Request-scoped dedupe (same pattern as PM / inbox / focus): every per-
// request loader shares one Promise<user|null> via this WeakMap.  GC'd when
// the request exits.
const userCache = new WeakMap<Request, Promise<AppUser | null>>();

export function getCurrentUser(): Promise<AppUser | null> {
  const req = getRequest();
  if (!req) {
    return resolveUser(null);
  }
  let p = userCache.get(req);
  if (!p) {
    const cookie = req.headers.get('cookie') ?? null;
    p = resolveUser(cookie);
    userCache.set(req, p);
  }
  return p;
}

async function resolveUser(cookie: string | null): Promise<AppUser | null> {
  const env = getEnv();
  const token = readSessionToken(cookie);
  if (!token) return null;
  const payload = await verifySessionToken(env, token);
  if (!payload?.sub) return null;
  return findUserBySsoImpl(getDb(env), payload.sub);
}

export class UnauthorizedError extends Error {
  constructor(message = 'Unauthorized') {
    super(message);
    this.name = 'UnauthorizedError';
  }
}

export async function requireUser(): Promise<AppUser> {
  const u = await getCurrentUser();
  if (!u) throw new UnauthorizedError();
  return u;
}
/* v8 ignore stop */
