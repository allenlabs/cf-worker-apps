import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { sql } from 'drizzle-orm';
import { type DB } from '~/db/client';
import * as schema from '~/db/schema';

export type TestDB = DB;

// Today doesn't own any tables — it reads across pm.*, inbox.*, focus.*.
// We install minimal shims for every schema rather than loading the other
// apps' migrations: their migrations carry baggage (foreign keys to seed
// rows, CHECK constraints, indexes) that we don't need here, and copying
// them verbatim would make this test setup brittle to other apps'
// independent migration cadence.
//
// Helper toggles let individual tests verify the to_regclass probes in
// loadTodayImpl — pass { withInbox: false } / { withFocus: false } to
// simulate a freshly-deployed today before its peers exist.

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
  CREATE TABLE IF NOT EXISTS pm.projects (
    id SERIAL PRIMARY KEY,
    identifier TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS pm.issue_statuses (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    is_closed BOOLEAN NOT NULL DEFAULT FALSE
  );
  CREATE TABLE IF NOT EXISTS pm.issues (
    id SERIAL PRIMARY KEY,
    project_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    status_id INTEGER NOT NULL,
    author_id INTEGER NOT NULL,
    assigned_to_id INTEGER,
    due_date TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS pm.activities (
    id SERIAL PRIMARY KEY,
    project_id INTEGER,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    ref_id INTEGER,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const INBOX_SHIM = `
  CREATE SCHEMA IF NOT EXISTS inbox;
  CREATE TABLE IF NOT EXISTS inbox.items (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'unread',
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

const FOCUS_SHIM = `
  CREATE SCHEMA IF NOT EXISTS focus;
  CREATE TABLE IF NOT EXISTS focus.sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    task_text TEXT NOT NULL,
    target_minutes INTEGER NOT NULL DEFAULT 25,
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ended_at TIMESTAMPTZ,
    ended_reason TEXT
  );
`;

export async function makeTestDb(
  opts: { withInbox?: boolean; withFocus?: boolean } = {},
): Promise<TestDB> {
  const pglite = new PGlite();
  await pglite.exec(PM_SHIM);
  if (opts.withInbox ?? true) await pglite.exec(INBOX_SHIM);
  if (opts.withFocus ?? true) await pglite.exec(FOCUS_SHIM);
  return drizzle(pglite, { schema }) as unknown as TestDB;
}

// ---------- Fixture helpers ----------

function rowsOf(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
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
  const row = rowsOf(result)[0] as
    | { id: number; login: string; email: string; sub: string }
    | undefined;
  if (!row) throw new Error('insertPmUser returned no row');
  return row;
}

export async function insertPmProject(
  db: TestDB,
  identifier: string,
  name: string = identifier,
): Promise<{ id: number; identifier: string; name: string }> {
  const result = (await db.execute(
    sql`INSERT INTO pm.projects (identifier, name) VALUES (${identifier}, ${name}) RETURNING id, identifier, name`,
  )) as unknown;
  const row = rowsOf(result)[0] as { id: number; identifier: string; name: string } | undefined;
  if (!row) throw new Error('insertPmProject returned no row');
  return row;
}

export async function insertPmStatus(
  db: TestDB,
  name: string,
  isClosed = false,
): Promise<{ id: number; name: string; isClosed: boolean }> {
  const result = (await db.execute(
    sql`INSERT INTO pm.issue_statuses (name, is_closed) VALUES (${name}, ${isClosed}) RETURNING id, name, is_closed AS "isClosed"`,
  )) as unknown;
  const row = rowsOf(result)[0] as { id: number; name: string; isClosed: boolean } | undefined;
  if (!row) throw new Error('insertPmStatus returned no row');
  return row;
}

export async function insertPmIssue(
  db: TestDB,
  fields: {
    projectId: number;
    subject: string;
    statusId: number;
    authorId: number;
    assignedToId?: number | null;
    dueDate?: string | null;
    updatedAt?: Date;
  },
): Promise<number> {
  const result = (await db.execute(
    sql`
      INSERT INTO pm.issues (project_id, subject, status_id, author_id, assigned_to_id, due_date, updated_at)
      VALUES (
        ${fields.projectId},
        ${fields.subject},
        ${fields.statusId},
        ${fields.authorId},
        ${fields.assignedToId ?? null},
        ${fields.dueDate ?? null},
        ${(fields.updatedAt ?? new Date()).toISOString()}::timestamptz
      )
      RETURNING id
    `,
  )) as unknown;
  return (rowsOf(result)[0] as { id: number }).id;
}

export async function insertPmActivity(
  db: TestDB,
  fields: {
    userId: number;
    title: string;
    kind?: string;
    projectId?: number | null;
    createdAt?: Date;
  },
): Promise<number> {
  const result = (await db.execute(
    sql`
      INSERT INTO pm.activities (user_id, title, kind, project_id, created_at)
      VALUES (
        ${fields.userId},
        ${fields.title},
        ${fields.kind ?? 'commented'},
        ${fields.projectId ?? null},
        ${(fields.createdAt ?? new Date()).toISOString()}::timestamptz
      )
      RETURNING id
    `,
  )) as unknown;
  return (rowsOf(result)[0] as { id: number }).id;
}

export async function insertInboxItem(
  db: TestDB,
  fields: {
    userId: number;
    text: string;
    status?: 'unread' | 'pinned' | 'done' | 'dropped' | 'snoozed';
    source?: string | null;
    capturedAt?: Date;
  },
): Promise<number> {
  const result = (await db.execute(
    sql`
      INSERT INTO inbox.items (user_id, text, status, source, captured_at)
      VALUES (
        ${fields.userId},
        ${fields.text},
        ${fields.status ?? 'unread'},
        ${fields.source ?? null},
        ${(fields.capturedAt ?? new Date()).toISOString()}::timestamptz
      )
      RETURNING id
    `,
  )) as unknown;
  return Number((rowsOf(result)[0] as { id: number }).id);
}

export async function insertFocusSession(
  db: TestDB,
  fields: {
    userId: number;
    taskText: string;
    targetMinutes?: number;
    startedAt?: Date;
    endedAt?: Date | null;
    endedReason?: 'completed' | 'abandoned' | 'extended' | null;
  },
): Promise<number> {
  const result = (await db.execute(
    sql`
      INSERT INTO focus.sessions (user_id, task_text, target_minutes, started_at, ended_at, ended_reason)
      VALUES (
        ${fields.userId},
        ${fields.taskText},
        ${fields.targetMinutes ?? 25},
        ${(fields.startedAt ?? new Date()).toISOString()}::timestamptz,
        ${fields.endedAt ? fields.endedAt.toISOString() : null},
        ${fields.endedReason ?? null}
      )
      RETURNING id
    `,
  )) as unknown;
  return Number((rowsOf(result)[0] as { id: number }).id);
}
