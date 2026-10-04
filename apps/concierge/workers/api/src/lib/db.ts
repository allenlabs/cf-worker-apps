// API-worker-local DB client.  Same rationale as inbox/focus/context
// api/lib/db.ts — we deliberately do NOT reuse the web worker's
// `~/db/client` because that imports `@tanstack/react-start/server` to
// participate in the SSR per-request cache.  The API worker is plain Hono
// — no SSR runtime needed.

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
    connection: { search_path: 'concierge, public' },
  });
  return drizzle(raw, { schema }) as unknown as DB;
}
