// API-worker-local DB client. Plain postgres.js over Hyperdrive — no drizzle
// schema needed since the editor API speaks raw parameterised SQL.
//
// Hyperdrive's network-level pool keeps per-request client construction cheap,
// so we make a fresh client per request (no module-level singleton that could
// leak across isolates).

import postgres from 'postgres';
import type { Env } from './env';

export type Sql = ReturnType<typeof postgres>;

export function makeDb(env: Pick<Env, 'HYPERDRIVE'>): Sql {
  return postgres(env.HYPERDRIVE.connectionString, {
    max: 4,
    fetch_types: false,
    prepare: false,
    idle_timeout: 5,
    connection: { search_path: 'editor, public' },
  });
}
