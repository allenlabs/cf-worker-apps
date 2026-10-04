-- Initial schema for Dopamine (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Celebration ledger — captures small wins via HMAC webhooks, renders a
-- 'things you did' feed; 'Remind me of a win' surfaces a random highlight.

CREATE SCHEMA IF NOT EXISTS dopamine;
SET search_path = dopamine, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA dopamine';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS dopamine.events (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  source_ref  TEXT,
  importance  SMALLINT NOT NULL DEFAULT 1,
  tags        TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS events_user_occurred_idx
  ON dopamine.events (user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS events_tags_gin
  ON dopamine.events USING gin (tags);

CREATE TABLE IF NOT EXISTS dopamine.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dopamine_api_clients_user_idx
  ON dopamine.api_clients (user_id);

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
    INSERT INTO dopamine.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
