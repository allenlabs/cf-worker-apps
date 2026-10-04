// Cross-schema user lookup — see stash/inbox/focus equivalents.

import { sql } from 'drizzle-orm';
import { type DB } from '~/db/client';

export interface AppUser {
  id: number;
  login: string;
  email: string;
  isAdmin: boolean;
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

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
