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
    connection: { search_path: 'nudge, public' },
  });
  return drizzle(raw, { schema }) as unknown as DB;
}
