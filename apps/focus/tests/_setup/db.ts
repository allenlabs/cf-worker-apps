import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type DB } from '~/db/client';
import * as schema from '~/db/schema';

export type TestDB = DB;

const ROOT = join(__dirname, '..', '..');
const MIGRATION = readFileSync(join(ROOT, 'drizzle-pg', '0001_initial.sql'), 'utf8');

// Focus stores user_id as a soft FK to pm.users.id.  In tests we don't run
// PM's migrations — we just create a minimal pm.users shim so impls that
// JOIN onto it (loadHomeImpl, findUserBySsoImpl) work.
//
// We also create a tiny inbox.items shim so loadHomeImpl's autocomplete
// subquery has something to read.  The to_regclass guard inside loadHomeImpl
// is also tested by *not* installing this shim in one test.
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

const INBOX_SHIM = `
  CREATE SCHEMA IF NOT EXISTS inbox;
  CREATE TABLE IF NOT EXISTS inbox.items (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unread',
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export async function makeTestDb(opts: { withInbox?: boolean } = {}): Promise<TestDB> {
  const pglite = new PGlite();
  await pglite.exec(PM_SHIM);
  if (opts.withInbox ?? true) {
    await pglite.exec(INBOX_SHIM);
  }
  await pglite.exec(MIGRATION);
  await pglite.exec(`SET search_path = focus, public;`);
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

export async function insertInboxItem(
  db: TestDB,
  userId: number,
  text: string,
  status: 'unread' | 'pinned' | 'done' = 'unread',
): Promise<number> {
  const result = (await db.execute(
    sql`
      INSERT INTO inbox.items (user_id, text, status)
      VALUES (${userId}, ${text}, ${status})
      RETURNING id
    `,
  )) as unknown;
  const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows ?? [];
  return (rows[0] as { id: number }).id;
}
