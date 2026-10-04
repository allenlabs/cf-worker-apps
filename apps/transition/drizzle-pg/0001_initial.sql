-- Initial schema for Transition (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Ritual prompts on context switch — fires at focus session end or
-- `al ctx save`.  Three questions: leaving_at / next_step / might_forget.
-- v1 just stores; fan-out to context/inbox/journal is a TODO.

CREATE SCHEMA IF NOT EXISTS transition;
SET search_path = transition, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA transition';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS transition.rituals (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL,
  leaving_at   TEXT NOT NULL,
  next_step    TEXT NOT NULL,
  might_forget TEXT,
  target       TEXT,                       -- null | 'context' | 'inbox' | 'journal'
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS rituals_user_created_idx
  ON transition.rituals (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transition.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS transition_api_clients_user_idx
  ON transition.api_clients (user_id);

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
    INSERT INTO transition.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
