-- Initial schema for Concierge (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- AI proactive-nudge worker.  Runs on cron (every 30 min) and on cross-app
-- events (issue closed, focus ended, capture, ...).  Pulls the user's recent
-- state across inbox / focus / context / pm, asks an OpenAI-compatible LLM
-- to compose ONE short ADHD-aware question, and delivers it via Web Push
-- (through inbox's existing push_subscriptions) and the today dashboard.
--
-- Lives in the shared allenlabs DB under the `concierge` schema.

CREATE SCHEMA IF NOT EXISTS concierge;
SET search_path = concierge, public;

-- pgcrypto for the api_clients seed below (gen_random_bytes).  On a fresh DB
-- we install it into the concierge schema; on a shared DB where pgcrypto is
-- already present under another schema we just rely on it being callable by
-- qualified name (the seed INSERT below looks up the actual ext schema).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA concierge';
  END IF;
END $$;

-- ---------- Nudges ----------
-- One row per composed question.  The LLM-generated text is stored alongside
-- the truncated state summary the model saw so we can debug "why did it pick
-- THIS thread?" after the fact.  Channels is a JSON array of where we tried
-- to deliver ('push' | 'today' | 'email') so the today loader knows whether
-- the user has already been pinged via another surface.
CREATE TABLE IF NOT EXISTS concierge.nudges (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL,                    -- soft FK to pm.users.id
  topic           TEXT NOT NULL,                       -- 'inbox-idle' | 'focus-abandoned' | 'pm-stalled' | 'celebration' | 'open-thread'
  question        TEXT NOT NULL,                       -- the LLM-composed text
  context_summary TEXT,                                -- truncated summary the LLM saw (for debugging)
  model           TEXT,                                -- which model/endpoint produced it
  channels        JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ['push','today','email']
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  opened_at       TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  replied_at      TIMESTAMPTZ,
  reply_text      TEXT
);
CREATE INDEX IF NOT EXISTS nudges_user_sent_idx
  ON concierge.nudges (user_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS nudges_user_active_idx
  ON concierge.nudges (user_id)
  WHERE dismissed_at IS NULL AND replied_at IS NULL;

-- ---------- Preferences ----------
-- One row per user.  `enabled = false` opts out entirely.  Quiet hours are
-- minutes-from-UTC-midnight (mirrors inbox.push_preferences); cadence_minutes
-- is the minimum gap between proactive nudges (anti-spam — without this the
-- cron would happily fire every 30 min).
CREATE TABLE IF NOT EXISTS concierge.preferences (
  user_id         INTEGER PRIMARY KEY,                 -- soft FK to pm.users.id
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  quiet_start     INTEGER,                             -- minutes from midnight (UTC), e.g. 22*60
  quiet_end       INTEGER,
  cadence_minutes INTEGER NOT NULL DEFAULT 240,        -- min minutes between proactive nudges
  last_nudge_at   TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- API clients ----------
-- HMAC-authenticated programmatic clients.  Mirrors inbox/focus/context
-- api_clients verbatim — other apps POST event payloads here using the
-- same scheme so concierge can decide whether to compose+send a nudge.
-- Seed a `cli` row for user_id = 1 (and an `inbox` / `focus` / `pm` row so
-- the cross-app event posts auth too).
CREATE TABLE IF NOT EXISTS concierge.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,                           -- 32 random bytes, base64
  user_id     INTEGER NOT NULL,                        -- soft FK to pm.users.id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_clients_user_idx
  ON concierge.api_clients (user_id);

-- Seed the default api_clients rows.  pgcrypto's `gen_random_bytes` may live
-- in any schema on the shared DB; look it up and EXECUTE the seed dynamically.
DO $$
DECLARE
  ext_schema text;
BEGIN
  SELECT n.nspname INTO ext_schema
    FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE e.extname = 'pgcrypto';
  IF ext_schema IS NULL THEN
    RAISE EXCEPTION 'pgcrypto extension is required for the api_clients seed';
  END IF;
  EXECUTE format($f$
    INSERT INTO concierge.api_clients (client_id, name, hmac_secret, user_id)
    VALUES
      ('cli',   'Allen Labs CLI',     encode(%I.gen_random_bytes(32), 'base64'), 1),
      ('inbox', 'Inbox event bridge', encode(%I.gen_random_bytes(32), 'base64'), 1),
      ('focus', 'Focus event bridge', encode(%I.gen_random_bytes(32), 'base64'), 1),
      ('pm',    'PM event bridge',    encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema, ext_schema, ext_schema, ext_schema);
END $$;
