// API-worker-local DB client.  Same rationale as inbox's api/lib/db.ts —
// we deliberately do NOT reuse the web worker's `~/db/client` because that
// imports `@tanstack/react-start/server` to participate in the SSR
// per-request cache.  The API worker is plain Hono — no SSR runtime, no
// per-request cache needed.  Hyperdrive's network-level pool keeps
// per-request client construction cheap.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../../web/app/db/schema';
import type { DB } from '../../../web/app/db/client';

export function makeDb(env: { HYPERDRIVE: Hyperdrive }): DB {
  const raw = postgres(env.HYPERDRIVE.connectionString, {
    max: 4,
    fetch_types: false,
    prepare: false,
    idle_timeout: 5,
    connection: { search_path: 'focus, public' },
  });
  return drizzle(raw, { schema }) as unknown as DB;
}
