// TanStack Start–aware helpers.  Split from `auth.ts` so that the testable
// `*Impl` functions can be imported without dragging in the SSR runtime.
//
// Coverage for this file comes from the wrangler integration tests in
// tests/workers/ (they exercise the same code paths via real HTTP requests).
/* v8 ignore start */
import { getRequest } from '@tanstack/react-start/server';
import { type DB, makeDb } from '@allenlabs/pm-core/db/client';
import type { Env } from '~/lib/env';
import {
  type AuthContext,
  type Permission,
  ForbiddenError,
  UnauthorizedError,
} from '@allenlabs/pm-core/lib/permissions';
import {
  buildAuthContextImpl,
  checkPermission,
  type CurrentUser,
  userFromSessionImpl,
} from './auth';
import { type AuthAdapter } from './auth/types';
import { selectAdapter } from './auth/registry';

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

export function getAdapter(env: Env = getEnv()): AuthAdapter {
  return selectAdapter(env);
}

// Request-scoped dedupe.  TanStack Start's `beforeLoad` + `loader` + any
// nested server fns each call into these helpers — without dedupe a
// single /projects load was doing 3 separate `users.findFirst` queries
// (one per call site) plus the redundant lookup inside
// `buildAuthContextImpl`.  WeakMap keyed on the in-flight Request: GC'd
// automatically once the request handler exits.
const userCache = new WeakMap<Request, Promise<CurrentUser | null>>();
const ctxCache = new WeakMap<Request, Map<number, Promise<AuthContext>>>();

export function getCurrentUser(): Promise<CurrentUser | null> {
  const req = getRequest();
  if (!req) {
    const env = getEnv();
    return userFromSessionImpl(getDb(env), getAdapter(env), env, null);
  }
  let p = userCache.get(req);
  if (!p) {
    const env = getEnv();
    const cookie = req.headers.get('cookie') ?? null;
    p = userFromSessionImpl(getDb(env), getAdapter(env), env, cookie);
    userCache.set(req, p);
  }
  return p;
}

export async function requireUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new UnauthorizedError();
  return u;
}

export function buildAuthContext(userId: number): Promise<AuthContext> {
  const req = getRequest();
  if (!req) return buildAuthContextImpl(getDb(), userId);
  let perReq = ctxCache.get(req);
  if (!perReq) {
    perReq = new Map();
    ctxCache.set(req, perReq);
  }
  let p = perReq.get(userId);
  if (!p) {
    // If `getCurrentUser` has already resolved this user inside this
    // request, hand its row to the impl so it can skip the redundant
    // `users.findFirst` (saves one full Hetzner RTT per loader).
    const cachedUser = userCache.get(req);
    if (cachedUser) {
      p = cachedUser.then((u) =>
        u && u.id === userId
          ? buildAuthContextImpl(getDb(), u)
          : buildAuthContextImpl(getDb(), userId),
      );
    } else {
      p = buildAuthContextImpl(getDb(), userId);
    }
    perReq.set(userId, p);
  }
  return p;
}

export async function requirePermission(
  projectId: number,
  permission: Permission,
): Promise<{ user: CurrentUser; ctx: AuthContext }> {
  const user = await requireUser();
  const ctx = await buildAuthContext(user.id);
  checkPermission(ctx, projectId, permission);
  return { user, ctx };
}

export async function requireAdmin(): Promise<CurrentUser> {
  const user = await requireUser();
  if (!user.isAdmin) throw new ForbiddenError('Admin only');
  return user;
}

/* v8 ignore stop */
