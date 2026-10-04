import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  pgSchema,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

export const gentle = pgSchema('gentle');

export const checkins = gentle.table(
  'checkins',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    entryDate: date('entry_date').notNull(),
    sleptOk: boolean('slept_ok'),
    meds: boolean('meds'),
    ate: boolean('ate'),
    moved: boolean('moved'),
    talked: boolean('talked'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userDateIdx: index('gentle_checkins_user_date_idx').on(t.userId, t.entryDate),
    userDateUnique: unique('gentle_checkins_user_date_unique').on(t.userId, t.entryDate),
  }),
);

export const apiClients = gentle.table(
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
    userIdx: index('gentle_api_clients_user_idx').on(t.userId),
  }),
);

export type Checkin = typeof checkins.$inferSelect;
export type NewCheckin = typeof checkins.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
