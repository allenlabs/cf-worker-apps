import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const context = pgSchema('context');

// ---------- Snapshots ----------
//
// One captured context.  Mirrors drizzle-pg/0001_initial.sql exactly.
// `userId` is a soft reference to pm.users.id — no cross-schema FK so the
// apps can be deployed independently.  `focusSessionId` / `inboxItemId` /
// `pmIssueId` are soft FKs to the corresponding apps' tables, captured at
// snapshot time so the restore view can deep-link back.
export const snapshots = context.table(
  'snapshots',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id').notNull(),
    name: text('name').notNull(),
    notes: text('notes'),
    // jsonb so we get cheap key access on Postgres; the CLI may stuff
    // anything (cwd, branch, files, processes, tabs, terminals, …).
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    focusSessionId: bigint('focus_session_id', { mode: 'number' }),
    pmIssueId: integer('pm_issue_id'),
    inboxItemId: bigint('inbox_item_id', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    restoredAt: timestamp('restored_at', { withTimezone: true, mode: 'date' }),
    restoredCount: integer('restored_count').notNull().default(0),
  },
  (t) => ({
    userCreatedIdx: index('snapshots_user_created_idx').on(t.userId, t.createdAt),
    userNameIdx: index('snapshots_user_name_idx').on(t.userId, t.name),
  }),
);

// ---------- API clients ----------
//
// HMAC-authenticated programmatic clients (CLI, browser extension, third-
// party automation).  One row per (client_id, user_id) pair — the API
// worker maps inbound `X-Client-Id` → user_id so the captured row is filed
// under the right user.
export const apiClients = context.table(
  'api_clients',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    clientId: text('client_id').notNull().unique(),
    name: text('name').notNull(),
    hmacSecret: text('hmac_secret').notNull(),
    userId: integer('user_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userIdx: index('api_clients_user_idx').on(t.userId),
  }),
);

// Reference back to pm.users from auth.  We don't model it in Drizzle (no
// cross-schema FK), but PM's users table is the source of truth for `userId`.
export type Snapshot = typeof snapshots.$inferSelect;
export type NewSnapshot = typeof snapshots.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
