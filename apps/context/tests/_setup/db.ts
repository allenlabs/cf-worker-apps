import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DB } from '~/db/client';
import * as schema from '~/db/schema';

export type TestDB = DB;

const ROOT = join(__dirname, '..', '..');
const MIGRATION = readFileSync(join(ROOT, 'drizzle-pg', '0001_initial.sql'), 'utf8');

// Context stores user_id as a soft FK to pm.users.id.  In tests we don't run
// PM's migrations — we just create a minimal pm.users shim so impls that
// JOIN onto it (loadHomeImpl, findUserBySsoImpl) work.
const PM_SHIM = `
  CREATE SCHEMA IF NOT EXISTS pm;
  CREATE TABLE IF NOT EXISTS pm.users (
    id SERIAL PRIMARY KEY,
    login TEXT NOT NULL,
    email TEXT NOT NULL,
    admin BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'active',
    better_auth_user_id TEXT
  );
`;

// The migration's seed row references user_id = 1.  pglite's serial starts at
// 1, so the order is: pm.users seeded → context migration → pm shim user
// already exists.  But we want the migration's INSERT INTO api_clients to
// succeed even when there's no pm.users row yet (production seeds it later
// via PM's deploy).  The migration uses ON CONFLICT DO NOTHING; pglite
// doesn't enforce cross-schema FKs (we don't model them), so it's fine.
export async function makeTestDb(): Promise<TestDB> {
  const pglite = await PGlite.create({ extensions: { pgcrypto } });
  await pglite.exec(PM_SHIM);
  await pglite.exec(MIGRATION);
  await pglite.exec(`SET search_path = context, public;`);
  return drizzle(pglite, { schema }) as unknown as TestDB;
}

export async function insertPmUser(
  db: TestDB,
  fields: { login?: string; email?: string; admin?: boolean; sub?: string } = {},
): Promise<{ id: number; login: string; email: string; sub: string }> {
  const login = fields.login ?? 'tester';
  const email = fields.email ?? `${login}@example.test`;
  const sub = fields.sub ?? `sso-${login}`;
  const admin = fields.admin ?? false;
  const result = (await db.execute(
    sql`
      INSERT INTO pm.users (login, email, admin, status, better_auth_user_id)
      VALUES (${login}, ${email}, ${admin}, 'active', ${sub})
      RETURNING id, login, email, better_auth_user_id AS sub
    `,
  )) as unknown;
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows ?? [];
  const row = rows[0] as { id: number; login: string; email: string; sub: string } | undefined;
  if (!row) throw new Error('insertPmUser returned no row');
  return row;
}
