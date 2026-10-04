import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  date,
  index,
  pgSchema,
  smallint,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const journal = pgSchema('journal');

export const entries = journal.table(
  'entries',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    entryDate: date('entry_date').notNull(),
    mood: smallint('mood'),
    energy: smallint('energy'),
    focus: smallint('focus'),
    mind: text('mind'),
    blockers: text('blockers'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    source: text('source'),
  },
  (t) => ({
    userDateIdx: index('entries_user_date_idx').on(t.userId, t.entryDate),
    userDateUnique: unique('entries_user_date_unique').on(t.userId, t.entryDate),
  }),
);

export const apiClients = journal.table(
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
    userIdx: index('journal_api_clients_user_idx').on(t.userId),
  }),
);

export type Entry = typeof entries.$inferSelect;
export type NewEntry = typeof entries.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
