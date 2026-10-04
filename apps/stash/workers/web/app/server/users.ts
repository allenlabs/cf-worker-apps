// Cross-schema user lookup.
//
// Stash doesn't own the `users` table — `pm.users` is the source of truth
// for every allenlabs app (PM, inbox, focus, context, stash, ...).  We reach
// into it directly via raw SQL because Drizzle's schema graph is per-app.

import { sql } from 'drizzle-orm';
import { type DB } from '~/db/client';

export interface AppUser {
  id: number;
  login: string;
  email: string;
  isAdmin: boolean;
}

function rowsOf(result: unknown): unknown[] {
  // postgres.js (production via Hyperdrive) returns a plain array.
  // drizzle/pglite (tests) returns `{ rows: [...] }`.  Support both.
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch;
     the plain-array path is what hits in production. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

/**
 * Look up a pm.users row by Better Auth user id (the JWT `sub`).  Returns
 * null if no row exists yet (first-time SSO sign-in hasn't been linked) or
 * if the row is locked.  Used by every authenticated request to map the
 * cookie -> user_id for soft-FK writes into stash.snippets.
 */
export async function findUserBySsoImpl(
  db: DB,
  sub: string,
): Promise<AppUser | null> {
  const result = (await db.execute(
    sql`
      SELECT id, login, email, admin AS "isAdmin"
      FROM pm.users
      WHERE better_auth_user_id = ${sub} AND status = 'active'
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  const row = first as AppUser;
  return {
    id: row.id,
    login: row.login,
    email: row.email,
    isAdmin: Boolean(row.isAdmin),
  };
}
