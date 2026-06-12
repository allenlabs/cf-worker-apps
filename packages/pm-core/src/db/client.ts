// Drizzle client backed by postgres.js + Cloudflare Hyperdrive.
//
// Hyperdrive proxies / pools connections to our Hetzner-hosted Postgres
// instance, so all the worker needs is the connection string it exposes on
// the binding. We pin the search_path to `pm, public` so unqualified table
// references in the drizzle schema resolve to our app schema.
//
// IMPORTANT: per-request client lifetime.
// In Cloudflare Workers, I/O objects (TCP sockets, streams) are owned by
// the request handler that created them — accessing them from a different
// request throws "Cannot perform I/O on behalf of a different request".
// So we CANNOT cache a `postgres()` client at module level: it opens
// real TCP sockets that get tied to the first request.  Hyperdrive does
// its own connection pooling at the network layer, so per-request client
// construction is cheap (no extra round-trip to Hetzner — Hyperdrive
// reuses its warm backend connection).
//
// To still bridge multiple `makeDb()` calls inside ONE request (every
// route loader + the auth-runtime helpers), we cache by request: a
// WeakMap keyed on the current Request gives every call within a request
// the same drizzle instance, and the WeakMap drops the entry once the
// request is GC'd.
//
// NOTE: Cold-start retry (still useful).
// Drizzle calls into `sql.unsafe(query, params)` (sometimes followed by
// `.values()` for array-mode results) for every query it issues. We wrap
// the postgres.js client in a Proxy that, for `unsafe`, returns a thenable
// which re-invokes `sql.unsafe(...)` on connection-shaped errors. Real
// PG errors — syntax, constraint, FK violations — are NOT retried.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getRequest } from '@tanstack/react-start/server';
import * as schema from './schema';

// Three attempts total: immediate retry, then backoffs.  Cold-start
// races usually resolve in <300 ms, but Hyperdrive's first request after
// a long idle can take longer to re-establish the TLS session.  Adding a
// third attempt with 250 ms backoff covers the long tail without making
// real errors visibly slow.
const COLD_START_BACKOFFS_MS: ReadonlyArray<number> = [0, 50, 250];

/**
 * Should this thrown error be retried?  PG-side errors carry an SQLSTATE
 * `code` (5 chars, all digits/letters) — those are deterministic (syntax,
 * unique violation, FK, NOT NULL …) and re-issuing the query won't help.
 * Everything else — socket-level, DNS, "Failed query" with no SQLSTATE
 * cause, generic Error — is treated as connection-shaped and retried.
 *
 * We err on the side of MORE retries: false positives just mean we waste
 * ~100 ms on a doomed query; false negatives leave a user staring at a
 * "Failed query" page on every cold-start race like the one Hyperdrive
 * has on the first request after a fresh isolate.
 */
function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true;
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  // SQLSTATE class '08' = connection_exception — these ARE retryable
  // (08000 connection_exception, 08003 connection_does_not_exist,
  //  08006 connection_failure, 08001 unable_to_establish, 08004
  //  rejected, 08007 transaction_resolution_unknown).  Don't blanket-
  //  reject all SQLSTATEs.
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    if (code.startsWith('08')) return true;
    return false;
  }
  // postgres.js synthesises a couple of non-SQLSTATE codes for
  // pre-protocol failures: CONNECTION_DESTROYED, CONNECTION_ENDED,
  // CONNECT_TIMEOUT, ECONNRESET, etc.  Those are connection-shape too.
  if (e.name === 'PostgresError' && !code) return true;
  if (e.name === 'PostgresError') return false;
  // Drizzle's wrapper exposes the underlying cause on `e.cause`; check
  // there in case the SQLSTATE lives one level down.
  if (e.cause && e.cause !== err) return isRetryableError(e.cause);
  // Otherwise (connection-shape, "Failed query" wrapper, plain Error,
  // fetch error from Hyperdrive's HTTP gateway) → retry.
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wrap a postgres.js `sql` client so every `.unsafe(query, params)` call
 * — which is how drizzle-orm/postgres-js dispatches every query — gets one
 * automatic retry on connection-shaped errors. Tagged-template calls
 * `sql`SELECT ...`` are not used by Drizzle (it always goes through
 * `unsafe`), but we still proxy the function itself so direct callers
 * would inherit the same behaviour.
 *
 * Exported so tests can drive the retry loop directly without instantiating
 * a real Postgres connection.
 */
export function wrapWithColdStartRetry(
  client: ReturnType<typeof postgres>,
): ReturnType<typeof postgres> {
  const handler: ProxyHandler<ReturnType<typeof postgres>> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'unsafe' || typeof value !== 'function') return value;
      // `unsafe(query, params, opts?)` returns a PendingQuery — a thenable
      // that also exposes chainable modifiers like `.values()`. We return
      // a lazy wrapper that defers calling `target.unsafe(...)` until the
      // caller actually awaits (or calls `.values()` then awaits), so we
      // can re-issue the call from scratch on a connection-shape failure.
      return function unsafeWithRetry(this: unknown, ...args: unknown[]) {
        return makeRetryingPendingQuery(target, args, /* arrayMode */ false);
      };
    },
  };
  return new Proxy(client, handler);
}

type PendingLike = {
  then: (...a: unknown[]) => unknown;
  catch?: (...a: unknown[]) => unknown;
  finally?: (...a: unknown[]) => unknown;
  values?: () => PendingLike;
};

function makeRetryingPendingQuery(
  client: ReturnType<typeof postgres>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  args: any[],
  arrayMode: boolean,
): PendingLike {
  // Execute the underlying `client.unsafe(...)` with retry semantics. We
  // build the PendingQuery fresh on each attempt so postgres.js owns a
  // clean state machine per attempt.
  const run = async (): Promise<unknown> => {
    let attempt = 0;
    const maxAttempts = COLD_START_BACKOFFS_MS.length;
    while (true) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pending = (client.unsafe as any)(...args);
        return await (arrayMode ? pending.values() : pending);
      } catch (err) {
        const next = attempt + 1;
        if (next < maxAttempts && isRetryableError(err)) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`[db retry ${next}/${maxAttempts - 1}]`, msg.slice(0, 300));
          attempt = next;
          const backoff = COLD_START_BACKOFFS_MS[next] ?? 0;
          if (backoff > 0) await sleep(backoff);
          continue;
        }
        throw err;
      }
    }
  };

  const wrapper: PendingLike = {
    // Thenable surface — `await wrapper` calls this.
    then(onFulfilled, onRejected) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return run().then(onFulfilled as any, onRejected as any);
    },
    catch(onRejected) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return run().catch(onRejected as any);
    },
    finally(onFinally) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return run().finally(onFinally as any);
    },
    // Drizzle's array-mode path calls `.values()` before awaiting.
    values() {
      return makeRetryingPendingQuery(client, args, true);
    },
  };
  return wrapper;
}

// Per-request drizzle instance cache.  WeakMap keyed on the in-flight
// Request so every `makeDb()` inside a single request shares one client
// (and therefore one connection pool, ~3 sockets max) — but the entry
// drops as soon as the request handler exits.
const dbByRequest = new WeakMap<
  Request,
  ReturnType<typeof drizzle<typeof schema>>
>();

function buildClient(env: { HYPERDRIVE: Hyperdrive }) {
  const raw = postgres(env.HYPERDRIVE.connectionString, {
    // Big enough to run every page's parallel fan-out in one batch — the
    // hottest route (my/page) issues 4 simultaneous queries plus the auth
    // lookup the route prelude has already kicked off.  Hyperdrive
    // backend pool is configured for 60 conns, so 8 per isolate is fine.
    max: 8,
    // Skip the introspective `pg_type` round-trip — Hyperdrive doesn't need
    // it and it saves a request on cold start.
    fetch_types: false,
    // Workers' TCP socket lifetimes are too short for prepared statements
    // to provide a benefit; disable to keep statements stateless.
    prepare: false,
    idle_timeout: 5,
    connection: { search_path: 'pm, public' },
  });
  return wrapWithColdStartRetry(raw);
}

export function makeDb(env: { HYPERDRIVE: Hyperdrive }) {
  // Inside an SSR request lifecycle, reuse the same client across nested
  // `makeDb()` calls so the auth-runtime + route loaders share a pool.
  let req: Request | undefined;
  try {
    req = getRequest();
  } catch {
    /* Outside a request context (workers tests, scheduled triggers,
       background ctx.waitUntil work) — fall through to per-call client. */
  }
  if (req) {
    const cached = dbByRequest.get(req);
    if (cached) return cached;
    const fresh = drizzle(buildClient(env), { schema });
    dbByRequest.set(req, fresh);
    return fresh;
  }
  return drizzle(buildClient(env), { schema });
}

export type DB = ReturnType<typeof makeDb>;

export { schema };
