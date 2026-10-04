import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { getRequest } from '@tanstack/react-start/server';
import * as schema from './schema';

const COLD_START_BACKOFFS_MS: ReadonlyArray<number> = [0, 50, 250];

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return true;
  const e = err as { name?: unknown; code?: unknown; cause?: unknown };
  const code = typeof e.code === 'string' ? e.code : undefined;
  if (code && /^[0-9A-Z]{5}$/.test(code)) {
    if (code.startsWith('08')) return true;
    return false;
  }
  if (e.name === 'PostgresError' && !code) return true;
  if (e.name === 'PostgresError') return false;
  if (e.cause && e.cause !== err) return isRetryableError(e.cause);
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function wrapWithColdStartRetry(
  client: ReturnType<typeof postgres>,
): ReturnType<typeof postgres> {
  const handler: ProxyHandler<ReturnType<typeof postgres>> = {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'unsafe' || typeof value !== 'function') return value;
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

const dbByRequest = new WeakMap<
  Request,
  ReturnType<typeof drizzle<typeof schema>>
>();

function buildClient(env: { HYPERDRIVE: Hyperdrive }) {
  const raw = postgres(env.HYPERDRIVE.connectionString, {
    max: 4,
    fetch_types: false,
    prepare: false,
    idle_timeout: 5,
    connection: { search_path: 'intent, public' },
  });
  return wrapWithColdStartRetry(raw);
}

export function makeDb(env: { HYPERDRIVE: Hyperdrive }) {
  let req: Request | undefined;
  try {
    req = getRequest();
  } catch {
    /* outside a request context */
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
