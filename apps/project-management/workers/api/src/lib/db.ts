// API-worker-local DB client. We don't reuse the web worker's ~/db/client
// because that imports @tanstack/react-start/server for the SSR per-request
// cache; the API worker is plain Hono. Hyperdrive pools at the network layer,
// so per-request client construction is cheap.

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '@allenlabs/pm-core/db/schema';
import type { DB } from '@allenlabs/pm-core/db/client';

export function makeDb(env: { HYPERDRIVE: Hyperdrive }): DB {
  const raw = postgres(env.HYPERDRIVE.connectionString, {
    max: 4,
    fetch_types: false,
    prepare: false,
    idle_timeout: 5,
    connection: { search_path: 'pm, public' },
  });
  return drizzle(raw, { schema }) as unknown as DB;
}
