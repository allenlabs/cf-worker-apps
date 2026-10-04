import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  index,
  integer,
  pgSchema,
  serial,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const focus = pgSchema('focus');

// ---------- Sessions ----------
//
// One Pomodoro lock.  Mirrors drizzle-pg/0001_initial.sql exactly.
// `userId` is a soft reference to pm.users.id — no cross-schema FK so the
// apps can be deployed independently.  `inboxItemId` and `pmIssueId` are
// soft FKs to inbox.items.id / pm.issues.id respectively (optional — the
// session may be a freeform "fixing auth bug" with no upstream link).
export const sessions = focus.table(
  'sessions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    userId: integer('user_id').notNull(),
    taskText: text('task_text').notNull(),
    inboxItemId: bigint('inbox_item_id', { mode: 'number' }),
    pmIssueId: integer('pm_issue_id'),
    targetMinutes: integer('target_minutes').notNull().default(25),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'date' }),
    endedReason: text('ended_reason', {
      enum: ['completed', 'abandoned', 'extended'],
    }),
    notes: text('notes'),
    satisfaction: integer('satisfaction'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
  },
  (t) => ({
    userStartedIdx: index('sessions_user_started_idx').on(t.userId, t.startedAt),
    activeIdx: index('sessions_active_idx').on(t.userId),
  }),
);

// ---------- Distractions ----------
//
// A "wobble" — the user noticed they got distracted but didn't end the
// session.  Logged neutrally; the UI deliberately doesn't say "log
// distraction" (too punishing), it says "note a wobble".
export const distractions = focus.table(
  'distractions',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: bigint('session_id', { mode: 'number' }).notNull(),
    notedAt: timestamp('noted_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .default(sql`now()`),
    label: text('label').notNull(),
    details: text('details'),
  },
  (t) => ({
    sessionIdx: index('distractions_session_idx').on(t.sessionId),
  }),
);

// ---------- API clients ----------
//
// HMAC-authenticated programmatic clients (CLI, browser extension, third-
// party automation).  One row per (client_id, user_id) pair — the API
// worker maps inbound `X-Client-Id` → user_id so the captured row is filed
// under the right user's focus history.
export const apiClients = focus.table(
  'api_clients',
  {
    id: serial('id').primaryKey(),
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

// Reference back to pm.users from auth.  We don't model it in Drizzle (no
// cross-schema FK), but PM's users table is the source of truth for `userId`.
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Distraction = typeof distractions.$inferSelect;
export type NewDistraction = typeof distractions.$inferInsert;
export type ApiClient = typeof apiClients.$inferSelect;
