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

// Concierge reads from inbox.items, focus.sessions, pm.users, pm.issues,
// context.snapshots.  Tests build the minimum shim schemas it needs so the
// state-summary CTE runs against PGlite.  No FKs across schemas (we don't
// have them in production either) — just tables.
const FOREIGN_SCHEMA_SHIMS = `
  CREATE SCHEMA IF NOT EXISTS pm;
  CREATE TABLE IF NOT EXISTS pm.users (
    id SERIAL PRIMARY KEY,
    login TEXT NOT NULL,
    email TEXT NOT NULL,
    admin BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'active',
    better_auth_user_id TEXT
  );
  CREATE TABLE IF NOT EXISTS pm.issue_statuses (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    is_closed BOOLEAN NOT NULL DEFAULT FALSE
  );
  -- Real PM models workflow state on issue_statuses (id=1 "New", id=5
  -- "Closed", etc.); seed the minimum two rows so the join in concierge's
  -- state-summary CTE picks up open vs closed correctly.
  INSERT INTO pm.issue_statuses (id, name, is_closed) VALUES
    (1, 'New', FALSE), (5, 'Closed', TRUE)
    ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS pm.issues (
    id SERIAL PRIMARY KEY,
    subject TEXT NOT NULL,
    assigned_to_id INTEGER,
    status_id INTEGER NOT NULL DEFAULT 1,
    closed_at TIMESTAMPTZ
  );

  CREATE SCHEMA IF NOT EXISTS inbox;
  CREATE TABLE IF NOT EXISTS inbox.items (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unread',
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE SCHEMA IF NOT EXISTS focus;
  CREATE TABLE IF NOT EXISTS focus.sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    task_text TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    ended_reason TEXT
  );

  CREATE SCHEMA IF NOT EXISTS context;
  CREATE TABLE IF NOT EXISTS context.snapshots (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

export async function makeTestDb(): Promise<TestDB> {
  const pglite = await PGlite.create({ extensions: { pgcrypto } });
  await pglite.exec(FOREIGN_SCHEMA_SHIMS);
  await pglite.exec(MIGRATION);
  await pglite.exec(`SET search_path = concierge, public;`);
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
