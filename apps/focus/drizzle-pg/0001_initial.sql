-- Initial schema for Focus (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Pomodoro + single-task lock for ADHD developers.  Each session is one
-- intent ("for the next 25 minutes I'm working on X").  Distractions are
-- logged as neutral observations (the UI calls them "wobbles") so the user
-- can see patterns without feeling judged.  No streak counter, ever — the
-- 90-day heatmap is the only longitudinal view.
--
-- Lives in the shared allenlabs DB under the `focus` schema.

CREATE SCHEMA IF NOT EXISTS focus;
SET search_path = focus, public;

-- ---------- Sessions ----------
-- One row per Pomodoro lock.  `ended_at IS NULL` means the session is still
-- running.  The optional `inbox_item_id` / `pm_issue_id` columns are soft FKs
-- to the corresponding apps; we deliberately avoid cross-schema FKs so any
-- app's deploy lifecycle is independent.
CREATE TABLE IF NOT EXISTS focus.sessions (
  id              BIGSERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL,                       -- soft FK to pm.users.id
  task_text       TEXT NOT NULL,                          -- what the user said they'd work on
  inbox_item_id   BIGINT,                                 -- soft FK to inbox.items.id (optional)
  pm_issue_id     INTEGER,                                -- soft FK to pm.issues.id  (optional)
  target_minutes  INTEGER NOT NULL DEFAULT 25,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at        TIMESTAMPTZ,                            -- null = still running
  ended_reason    TEXT                                    -- 'completed' | 'abandoned' | 'extended'
                    CHECK (ended_reason IS NULL
                           OR ended_reason IN ('completed','abandoned','extended')),
  notes           TEXT,
  satisfaction    INTEGER                                 -- 1..5, post-session reflection
                    CHECK (satisfaction IS NULL OR satisfaction BETWEEN 1 AND 5),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sessions_user_started_idx
  ON focus.sessions (user_id, started_at DESC);
-- Partial index: there should only ever be ONE active session per user, so
-- this index also serves as the lookup path for "do I have an active
-- session?" from the home loader and the CLI `al focus active` command.
CREATE INDEX IF NOT EXISTS sessions_active_idx
  ON focus.sessions (user_id) WHERE ended_at IS NULL;

-- ---------- Distractions ----------
-- A "wobble" — the user noticed they got distracted but didn't end the
-- session.  Logged neutrally; the UI deliberately doesn't say "log
-- distraction" (too punishing), it says "note a wobble".
CREATE TABLE IF NOT EXISTS focus.distractions (
  id          BIGSERIAL PRIMARY KEY,
  session_id  BIGINT NOT NULL REFERENCES focus.sessions(id) ON DELETE CASCADE,
  noted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  label       TEXT NOT NULL,                              -- 'twitter' | 'slack' | 'random thought' | …
  details     TEXT
);
CREATE INDEX IF NOT EXISTS distractions_session_idx
  ON focus.distractions (session_id);

-- ---------- API clients ----------
-- HMAC-authenticated programmatic clients (CLI, browser extension, etc.).
-- Mirrors inbox.api_clients exactly so the same signing scheme works across
-- apps.  Seed a `cli` row → user_id = 1 so `al focus start "fixing auth"`
-- works out of the box on a fresh deploy.
CREATE TABLE IF NOT EXISTS focus.api_clients (
  id          SERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,                              -- 32 random bytes, base64
  user_id     INTEGER NOT NULL,                           -- soft FK to pm.users.id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_clients_user_idx
  ON focus.api_clients (user_id);
