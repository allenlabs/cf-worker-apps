import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const intent = pgSchema('intent');

export const current = intent.table('current', {
  userId: bigint('user_id', { mode: 'number' }).primaryKey(),
  text: text('text').notNull().default(''),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

export const history = intent.table(
  'history',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    text: text('text').notNull(),
    setAt: timestamp('set_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userSetAtIdx: index('history_user_set_at_idx').on(t.userId, t.setAt),
  }),
);

export const apiClients = intent.table(
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
    userIdx: index('intent_api_clients_user_idx').on(t.userId),
  }),
);

export type CurrentRow = typeof current.$inferSelect;
export type HistoryRow = typeof history.$inferSelect;
export type ApiClient = typeof apiClients.$inferSelect;
