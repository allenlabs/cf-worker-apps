import type { Env } from '~/lib/env';

// In-memory D1 implementation good enough for session-revocation tests.
// Recognises the two statements session.server.ts issues against the
// `revoked_sessions` table (INSERT … ON CONFLICT … and SELECT … WHERE … >
// unixepoch()); everything else throws so a stray query in a future test
// surfaces loudly instead of silently no-opping.
export function makeMemoryAuthDb(): D1Database {
  const store = new Map<string, number>(); // key -> expires_at (unix sec)
  const now = () => Math.floor(Date.now() / 1000);

  function statement(sql: string) {
    const args: unknown[] = [];
    const api = {
      bind(...bindings: unknown[]) {
        args.push(...bindings);
        return api;
      },
      async run() {
        if (/INSERT INTO revoked_sessions/i.test(sql)) {
          const [key, ttl] = args as [string, number];
          store.set(key, now() + ttl);
          return { success: true } as unknown as D1Result;
        }
        throw new Error(`unexpected D1 statement: ${sql}`);
      },
      async first<T = unknown>(): Promise<T | null> {
        if (/SELECT 1 FROM revoked_sessions/i.test(sql)) {
          const [key] = args as [string];
          const exp = store.get(key);
          if (exp === undefined || exp <= now()) return null;
          return { '1': 1 } as unknown as T;
        }
        throw new Error(`unexpected D1 statement: ${sql}`);
      },
    };
    return api as unknown as D1PreparedStatement;
  }

  return {
    prepare: statement,
  } as unknown as D1Database;
}

// Back-compat alias for the renamed helper. Older tests imported makeMemoryKV;
// the contract (in-memory revocation store usable as the JWT-revocation
// binding) is the same. Returns a D1Database now that the binding moved.
export function makeMemoryKV(): D1Database {
  return makeMemoryAuthDb();
}

export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    HYPERDRIVE: {} as unknown as Hyperdrive,
    AUTH_DB: makeMemoryAuthDb(),
    ASSETS: {} as Fetcher,
    APP_NAME: 'Inbox (test)',
    DEFAULT_LANGUAGE: 'en',
    AUTH_WEB_URL: 'https://auth.test',
    AUTH_API_URL: 'https://auth-api.test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    OTEL_ACCESS_ID: 'test-otel-id',
    OTEL_ACCESS_SECRET: 'test-otel-secret',
    OTEL_BEARER_TOKEN: 'test-otel-bearer',
    VAPID_PUBLIC_KEY: 'test-vapid-public',
    VAPID_PRIVATE_KEY: 'test-vapid-private',
    VAPID_SUBJECT: 'mailto:test@example.test',
    ...overrides,
  };
}
