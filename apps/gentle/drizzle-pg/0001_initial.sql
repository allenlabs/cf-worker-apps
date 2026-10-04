-- Initial schema for Gentle (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Daily soft check-in.  NOT a habit tracker — NO streak counter, NO
-- "you missed N days" messaging.  Just 5 binary toggles + an optional note,
-- visualised as a 90-day heatmap where missed days FADE but never reset.
--
-- Lives in the shared allenlabs DB under the `gentle` schema.

CREATE SCHEMA IF NOT EXISTS gentle;
SET search_path = gentle, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA gentle';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS gentle.checkins (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  entry_date  DATE NOT NULL,
  slept_ok    BOOLEAN,
  meds        BOOLEAN,
  ate         BOOLEAN,
  moved       BOOLEAN,
  talked      BOOLEAN,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, entry_date)
);
CREATE INDEX IF NOT EXISTS gentle_checkins_user_date_idx
  ON gentle.checkins (user_id, entry_date DESC);

CREATE TABLE IF NOT EXISTS gentle.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS gentle_api_clients_user_idx
  ON gentle.api_clients (user_id);

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
    INSERT INTO gentle.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
