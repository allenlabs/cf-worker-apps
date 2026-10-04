// Drizzle client backed by postgres.js + Cloudflare Hyperdrive.
//
// Pins `search_path = notion_gateway, public` so unqualified table
// references in the drizzle schema resolve to our app schema.  The
// Hyperdrive binding ID is shared with PM — they point at the same
// allenlabs Postgres instance, just different schemas.
//
// We wrap the postgres.js client in a Proxy that re-issues `.unsafe(...)`
// calls (which is how drizzle dispatches every query) exactly once on
// connection-shaped failures.  This is the same cold-start retry shape
// PM uses; see apps/project-management/workers/web/app/db/client.ts for
// the design rationale.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

let sql: ReturnType<typeof postgres> | null = null;

const COLD_START_BACKOFF_MS = 100;

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true;
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (code && /^[0-9A-Z]{5}$/.test(code)) return false;
  if (e.name === 'PostgresError') return false;
  if (e.cause && e.cause !== err) return isRetryableError(e.cause);
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
  const run = async (): Promise<unknown> => {
    let attempt = 0;
    while (true) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pending = (client.unsafe as any)(...args);
        return await (arrayMode ? pending.values() : pending);
      } catch (err) {
        if (attempt === 0 && isRetryableError(err)) {
          attempt++;
          await sleep(COLD_START_BACKOFF_MS);
          continue;
        }
        throw err;
      }
    }
  };

  const wrapper: PendingLike = {
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
    values() {
      return makeRetryingPendingQuery(client, args, true);
    },
  };
  return wrapper;
}

export function wrapWithColdStartRetry(
  client: ReturnType<typeof postgres>,
): ReturnType<typeof postgres> {
  const handler: ProxyHandler<ReturnType<typeof postgres>> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'unsafe' || typeof value !== 'function') return value;
      return function unsafeWithRetry(this: unknown, ...args: unknown[]) {
        return makeRetryingPendingQuery(target, args, false);
      };
    },
  };
  return new Proxy(client, handler);
}

export function makeDb(env: { HYPERDRIVE: Hyperdrive }) {
  if (!sql) {
    const raw = postgres(env.HYPERDRIVE.connectionString, {
      max: 5,
      fetch_types: false,
      prepare: false,
      connection: { search_path: 'notion_gateway, public' },
    });
    sql = wrapWithColdStartRetry(raw);
  }
  return drizzle(sql, { schema });
}

export type DB = ReturnType<typeof makeDb>;

export { schema };
