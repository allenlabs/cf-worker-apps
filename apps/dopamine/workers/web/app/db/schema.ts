import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  pgSchema,
  smallint,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const dopamine = pgSchema('dopamine');

export const events = dopamine.table(
  'events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    body: text('body'),
    sourceRef: text('source_ref'),
    importance: smallint('importance').notNull().default(1),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userOccurredIdx: index('events_user_occurred_idx').on(t.userId, t.occurredAt),
  }),
);

export const apiClients = dopamine.table(
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
    userIdx: index('dopamine_api_clients_user_idx').on(t.userId),
  }),
);

export type Event = typeof events.$inferSelect;
export type ApiClient = typeof apiClients.$inferSelect;
