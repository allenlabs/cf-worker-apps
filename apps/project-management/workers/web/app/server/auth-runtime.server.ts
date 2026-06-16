// TanStack Start–aware helpers.  Split from `auth.ts` so that the testable
// `*Impl` functions can be imported without dragging in the SSR runtime.
//
// Coverage for this file comes from the wrangler integration tests in
// tests/workers/ (they exercise the same code paths via real HTTP requests).
/* v8 ignore start */
import { getRequest } from '@tanstack/react-start/server';
import { type DB } from '@allenlabs/pm-core/db/client';
import type { Env } from '@allenlabs/pm-core/lib/env';
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
  userFromIdentityImpl,
} from '@allenlabs/pm-core/server/auth';
import { type AuthAdapter } from '@allenlabs/pm-core/server/auth/types';
import { selectAdapter } from '@allenlabs/pm-core/server/auth/registry';
import { resolveTenantDb, tenantKeyFor } from '@allenlabs/pm-core/server/tenancy';

function currentRequest(): Request | undefined {
  try {
    return getRequest();
  } catch {
    return undefined;
  }
}

// The tenant key resolved (once) from the verified identity by getCurrentUser,
// keyed per in-flight Request so every getDb() in that request hits the same
// tenant DB. Unset (public/unauthenticated) ⇒ the default tenant.
const requestTenantKey = new WeakMap<Request, string>();

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

// Tenant-aware: returns the DB for the request's resolved tenant (set by
// getCurrentUser from the verified identity), or the default tenant before/
// without an identity. With the default resolver this is exactly env.HYPERDRIVE.
export function getDb(env: Env = getEnv()): DB {
  const req = currentRequest();
  const key = (req && requestTenantKey.get(req)) || 'default';
  return resolveTenantDb(env, key);
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

// Verify the cookie → identity (JWT-only), pin the request's tenant key from it,
// then look the user up in that tenant's DB. Verifying before touching a DB is
// what makes per-tenant routing possible (we never resolve a DB before we know
// the identity).
async function resolveCurrentUser(
  env: Env,
  cookie: string | null,
  req: Request | undefined,
): Promise<CurrentUser | null> {
  const identity = await getAdapter(env).verify(env, cookie);
  if (!identity) return null;
  const key = tenantKeyFor(env, identity);
  if (req) requestTenantKey.set(req, key);
  return userFromIdentityImpl(resolveTenantDb(env, key), identity);
}

export function getCurrentUser(): Promise<CurrentUser | null> {
  const req = currentRequest();
  if (!req) {
    const env = getEnv();
    return resolveCurrentUser(env, null, undefined);
  }
  let p = userCache.get(req);
  if (!p) {
    const env = getEnv();
    const cookie = req.headers.get('cookie') ?? null;
    p = resolveCurrentUser(env, cookie, req);
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
