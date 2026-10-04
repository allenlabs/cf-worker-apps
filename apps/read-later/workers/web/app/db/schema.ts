import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const readLater = pgSchema('read_later');

// ---------- Items ----------
//
// One saved URL.  Mirrors drizzle-pg/0001_initial.sql exactly.  `userId` is
// a soft reference to pm.users.id — no cross-schema FK so the apps can be
// deployed independently.
export const items = readLater.table(
  'items',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    url: text('url').notNull(),
    title: text('title'),
    excerpt: text('excerpt'),
    contentHtml: text('content_html'),
    wordCount: integer('word_count'),
    estimatedMinutes: integer('estimated_minutes'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    savedAt: timestamp('saved_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    skippedCount: integer('skipped_count').notNull().default(0),
    source: text('source'),
  },
  (t) => ({
    userUnreadSavedIdx: index('items_user_unread_saved_idx').on(
      t.userId,
      t.readAt,
      t.savedAt,
    ),
  }),
);

// ---------- API clients ----------
//
// HMAC-authenticated programmatic clients (CLI, browser extension, third-
// party automation).  One row per (client_id, user_id) pair — the API
// worker maps inbound `X-Client-Id` → user_id so the captured row is filed
// under the right user.
export const apiClients = readLater.table(
  'api_clients',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    clientId: text('client_id').notNull().unique(),
    name: text('name').notNull(),
    hmacSecret: text('hmac_secret').notNull(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
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
export type Item = typeof items.$inferSelect;
export type NewItem = typeof items.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
