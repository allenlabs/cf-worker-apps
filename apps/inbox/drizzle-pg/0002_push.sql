-- Web Push subscriptions + per-user preferences.  Apply with:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0002_push.sql
--
-- Adds two tables to the inbox schema:
--   inbox.push_subscriptions — one row per (user, browser/device) endpoint
--   inbox.push_preferences   — per-user notification policy (quiet hours, opt-out)
--
-- Both `user_id` columns are soft FKs to `pm.users.id` (same convention as
-- the rest of inbox — no cross-schema FK so the two apps deploy independently).

SET search_path = inbox, public;

CREATE TABLE IF NOT EXISTS inbox.push_subscriptions (
  id           BIGSERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL,                          -- soft FK to pm.users.id
  endpoint     TEXT NOT NULL UNIQUE,                      -- unique per device/browser
  p256dh       TEXT NOT NULL,                             -- client public key (base64url)
  auth         TEXT NOT NULL,                             -- client auth secret (base64url)
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ,
  failed_count INTEGER NOT NULL DEFAULT 0                 -- ≥5 + 410-gone ⇒ cleanup
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx
  ON inbox.push_subscriptions (user_id);

CREATE TABLE IF NOT EXISTS inbox.push_preferences (
  user_id     INTEGER PRIMARY KEY,                        -- soft FK to pm.users.id
  on_capture  BOOLEAN NOT NULL DEFAULT TRUE,              -- toggle for "notify on each capture"
  quiet_start INTEGER,                                    -- minutes from midnight, 0..1439
  quiet_end   INTEGER,                                    -- end of quiet window (wraps if < start)
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
