// API-worker-local DB client.  Same rationale as stash/inbox/focus api/lib/db.ts —
// the web worker's client imports `@tanstack/react-start/server`; this one
// doesn't need that.

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
    connection: { search_path: 'solved, public' },
  });
  return drizzle(raw, { schema }) as unknown as DB;
}
