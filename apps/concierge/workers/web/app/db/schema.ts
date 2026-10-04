import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const concierge = pgSchema('concierge');

// ---------- Nudges ----------
//
// One row per composed question.  Mirrors drizzle-pg/0001_initial.sql exactly.
export const nudges = concierge.table(
  'nudges',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id').notNull(),
    topic: text('topic').notNull(),
    question: text('question').notNull(),
    contextSummary: text('context_summary'),
    model: text('model'),
    channels: jsonb('channels')
      .notNull()
      .default(sql`'[]'::jsonb`),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    openedAt: timestamp('opened_at', { withTimezone: true, mode: 'date' }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true, mode: 'date' }),
    repliedAt: timestamp('replied_at', { withTimezone: true, mode: 'date' }),
    replyText: text('reply_text'),
  },
  (t) => ({
    userSentIdx: index('nudges_user_sent_idx').on(t.userId, t.sentAt),
    userActiveIdx: index('nudges_user_active_idx').on(t.userId),
  }),
);

// ---------- Preferences ----------
//
// One row per user.  enabled=false opts out entirely.  Quiet hours are
// minutes-from-UTC-midnight; cadence_minutes is the min gap between
// proactive nudges.
export const preferences = concierge.table('preferences', {
  userId: integer('user_id').primaryKey(),
  enabled: boolean('enabled').notNull().default(true),
  quietStart: integer('quiet_start'),
  quietEnd: integer('quiet_end'),
  cadenceMinutes: integer('cadence_minutes').notNull().default(240),
  lastNudgeAt: timestamp('last_nudge_at', { withTimezone: true, mode: 'date' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .default(sql`now()`),
});

// ---------- API clients ----------
//
// HMAC-authenticated programmatic clients.  Other apps (inbox, focus, pm)
// POST event payloads here using the same scheme as inbox.api_clients.
export const apiClients = concierge.table(
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

export type Nudge = typeof nudges.$inferSelect;
export type NewNudge = typeof nudges.$inferInsert;
export type Preferences = typeof preferences.$inferSelect;
export type NewPreferences = typeof preferences.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
