-- Initial schema for Inbox (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Universal-capture inbox for ADHD developers.  The whole point is to get a
-- thought out of working memory and into a queue with zero structuring.
-- Triage happens later via the keyboard-driven UI at inbox.allen.company.
--
-- Lives in the shared allenlabs DB under the `inbox` schema.

CREATE SCHEMA IF NOT EXISTS inbox;
SET search_path = inbox, public;

-- ---------- Items ----------
-- The captured thought.  `user_id` is a soft ref to pm.users.id — every
-- allenlabs app shares the same users table via SSO mapping but we deliberately
-- avoid a cross-schema FK so neither app can pin the other's deploy lifecycle.
CREATE TABLE IF NOT EXISTS inbox.items (
  id            BIGSERIAL PRIMARY KEY,
  user_id       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  source        TEXT,                                  -- 'web' | 'cli' | 'ext' | 'email' | 'mobile' | null
  tags          TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  status        TEXT NOT NULL DEFAULT 'unread'         -- unread|pinned|done|dropped|snoozed
                  CHECK (status IN ('unread','pinned','done','dropped','snoozed')),
  snoozed_until TIMESTAMPTZ,
  refiled_to    JSONB,                                 -- {app:'pm', issueId: 123}
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS items_user_status_idx
  ON inbox.items (user_id, status, captured_at DESC);
CREATE INDEX IF NOT EXISTS items_snooze_idx
  ON inbox.items (snoozed_until) WHERE status = 'snoozed';

-- ---------- API clients ----------
-- HMAC-authenticated programmatic clients (CLI, browser extension, etc.).
-- Each row binds a client_id to a user, so /v1/capture POSTs from `cli`
-- file into the right user's inbox without password/JWT.
CREATE TABLE IF NOT EXISTS inbox.api_clients (
  id          SERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,                           -- 32 random bytes, base64
  user_id     INTEGER NOT NULL,                        -- soft ref to pm.users.id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_clients_user_idx ON inbox.api_clients (user_id);
