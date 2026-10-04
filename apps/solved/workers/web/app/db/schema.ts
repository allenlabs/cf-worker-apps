import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const solved = pgSchema('solved');

export const entries = solved.table(
  'entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    source: text('source'),
    sourceRef: text('source_ref'),
    sourceUrl: text('source_url'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userCreatedIdx: index('solved_entries_user_created_idx').on(t.userId, t.createdAt),
    tagsIdx: index('solved_entries_tags_idx').on(t.tags),
  }),
);

export const apiClients = solved.table(
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
    userIdx: index('solved_api_clients_user_idx').on(t.userId),
  }),
);

export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
