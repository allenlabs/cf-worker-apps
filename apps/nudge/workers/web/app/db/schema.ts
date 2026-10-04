import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const nudge = pgSchema('nudge');

export const reminders = nudge.table(
  'reminders',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    text: text('text').notNull(),
    fireAt: timestamp('fire_at', { withTimezone: true, mode: 'date' }).notNull(),
    nextFireAt: timestamp('next_fire_at', { withTimezone: true, mode: 'date' }),
    recurrence: text('recurrence'),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'date' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true, mode: 'date' }),
    source: text('source'),
  },
  (t) => ({
    userFireIdx: index('reminders_user_fire_idx').on(t.userId, t.fireAt),
    nextFireIdx: index('reminders_next_fire_idx').on(t.nextFireAt),
  }),
);

export const apiClients = nudge.table(
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
    userIdx: index('nudge_api_clients_user_idx').on(t.userId),
  }),
);

export type Reminder = typeof reminders.$inferSelect;
export type NewReminder = typeof reminders.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
