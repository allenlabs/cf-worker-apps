-- Initial schema for Journal (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Daily check-in + mood/energy tracking.  Short prompts, NO streak-shame —
-- 90-day heatmap visualisation only.

CREATE SCHEMA IF NOT EXISTS journal;
SET search_path = journal, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA journal';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS journal.entries (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  entry_date  DATE NOT NULL,
  mood        SMALLINT CHECK (mood BETWEEN 1 AND 5),
  energy      SMALLINT CHECK (energy BETWEEN 1 AND 5),
  focus       SMALLINT CHECK (focus BETWEEN 1 AND 5),
  mind        TEXT,
  blockers    TEXT,
  tags        TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source      TEXT,
  UNIQUE (user_id, entry_date)
);
CREATE INDEX IF NOT EXISTS entries_user_date_idx
  ON journal.entries (user_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS journal.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS journal_api_clients_user_idx
  ON journal.api_clients (user_id);

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
    INSERT INTO journal.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
