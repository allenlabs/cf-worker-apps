import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const stash = pgSchema('stash');

// ---------- Snippets ----------
//
// One saved snippet (code, command, note, anything).  Mirrors
// drizzle-pg/0001_initial.sql exactly.  `userId` is a soft reference to
// pm.users.id — no cross-schema FK so the apps deploy independently.  The
// `search_tsv` STORED generated column is set by Postgres on every INSERT /
// UPDATE; Drizzle never writes to it directly, so we don't model it here.
export const snippets = stash.table(
  'snippets',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    title: text('title'),
    body: text('body').notNull(),
    language: text('language'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    source: text('source'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userCreatedIdx: index('snippets_user_created_idx').on(t.userId, t.createdAt),
    tagsIdx: index('snippets_tags_idx').on(t.tags),
  }),
);

// ---------- API clients ----------
//
// HMAC-authenticated programmatic clients (CLI, browser extension, third-
// party automation).  One row per (client_id, user_id) pair — the API
// worker maps inbound `X-Client-Id` → user_id so the captured row is filed
// under the right user.
export const apiClients = stash.table(
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

export type Snippet = typeof snippets.$inferSelect;
export type NewSnippet = typeof snippets.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
