import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const transition = pgSchema('transition');

export const rituals = transition.table(
  'rituals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: bigint('user_id', { mode: 'number' }).notNull(),
    leavingAt: text('leaving_at').notNull(),
    nextStep: text('next_step').notNull(),
    mightForget: text('might_forget'),
    target: text('target'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userCreatedIdx: index('rituals_user_created_idx').on(t.userId, t.createdAt),
  }),
);

export const apiClients = transition.table(
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
    userIdx: index('transition_api_clients_user_idx').on(t.userId),
  }),
);

export type Ritual = typeof rituals.$inferSelect;
export type ApiClient = typeof apiClients.$inferSelect;
