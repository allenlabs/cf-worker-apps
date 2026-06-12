import type { Env } from '@allenlabs/pm-core/lib/env';

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

// In-memory R2 implementation good enough for attachment tests.
export function makeMemoryR2(): R2Bucket {
  const store = new Map<string, { body: Uint8Array; contentType?: string }>();
  return {
    async put(key: string, value: ArrayBufferView | ArrayBuffer | Uint8Array, opts?: any) {
      const bytes =
        value instanceof Uint8Array
          ? value
          : value instanceof ArrayBuffer
            ? new Uint8Array(value)
            : new Uint8Array((value as ArrayBufferView).buffer);
      store.set(key, { body: bytes, contentType: opts?.httpMetadata?.contentType });
      return { key };
    },
    async get(key: string) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        body: new ReadableStream({
          start(c) {
            c.enqueue(entry.body);
            c.close();
          },
        }),
        async arrayBuffer() {
          return entry.body.buffer.slice(
            entry.body.byteOffset,
            entry.body.byteOffset + entry.body.byteLength,
          );
        },
      } as unknown as R2ObjectBody;
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return {
        objects: Array.from(store.keys()).map((key) => ({ key, size: store.get(key)!.body.length })),
      } as any;
    },
  } as unknown as R2Bucket;
}

export function makeTestEnv(overrides: Partial<Env> = {}): Env {
  return {
    HYPERDRIVE: {} as unknown as Hyperdrive, // not used directly in unit tests; getDb is mocked
    FILES: makeMemoryR2(),
    AUTH_DB: makeMemoryAuthDb(),
    ASSETS: {} as Fetcher,
    APP_NAME: 'CF Redmine (test)',
    DEFAULT_LANGUAGE: 'en',
    AUTH_WEB_URL: 'https://auth.test',
    AUTH_API_URL: 'https://auth-api.test',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    OTEL_ACCESS_ID: 'test-otel-id',
    OTEL_ACCESS_SECRET: 'test-otel-secret',
    OTEL_BEARER_TOKEN: 'test-otel-bearer',
    // Gateway settings: the URL is a no-op base for tests; the secret is
    // a fixed-length string so HMAC derivation succeeds.
    NOTION_GATEWAY_URL: 'https://notion-api.test',
    NOTION_GATEWAY_CLIENT_ID: 'pm',
    NOTION_GATEWAY_SECRET: 'test-gateway-secret-1234567890ab',
    // Org bridge: URL reuses AUTH_API_URL; secret is a fixed-length string so
    // HMAC derivation succeeds in unit tests.
    PM_ORG_HMAC_CLIENT_ID: 'pm',
    PM_ORG_HMAC_SECRET: 'test-org-hmac-secret-1234567890abcd',
    ...overrides,
  };
}

// Shared state object so vi.hoisted-friendly mock factories can mutate it
// from `beforeEach` without recreating the mock itself.
export function makeAuthState() {
  return {
    db: null as any,
    env: null as Env | null,
    currentUser: null as null | {
      id: number;
      login: string;
      email: string;
      firstname: string;
      lastname: string;
      isAdmin: boolean;
      avatarUrl: string | null;
    },
    ctx: null as null | {
      userId: number;
      isAdmin: boolean;
      permissionsByProject: Record<number, Set<string>>;
    },
  };
}

export type AuthState = ReturnType<typeof makeAuthState>;

// Vitest-friendly factory for mocking `~/server/auth`.  Call this from inside
// `vi.mock('@allenlabs/pm-core/server/auth', () => buildAuthMock(state))`.
export function buildAuthMock(state: AuthState) {
  return {
    getEnv: () => state.env!,
    getDb: () => state.db,
    getCurrentUser: async () => state.currentUser,
    requireUser: async () => {
      if (!state.currentUser) throw new Error('UnauthorizedError');
      return state.currentUser;
    },
    requireAdmin: async () => {
      if (!state.currentUser?.isAdmin) throw new Error('ForbiddenError');
      return state.currentUser;
    },
    buildAuthContext: async () => state.ctx!,
    requirePermission: async () => ({ user: state.currentUser!, ctx: state.ctx! }),
  };
}
