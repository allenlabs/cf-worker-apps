-- Initial schema for Nudge (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- User-scheduled reminders, gentle ADHD-friendly framing.  Manual + recurring
-- patterns.  Distinct from concierge (which is AI-driven).
--
-- Lives in the shared allenlabs DB under the `nudge` schema.

CREATE SCHEMA IF NOT EXISTS nudge;
SET search_path = nudge, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA nudge';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS nudge.reminders (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL,
  text            TEXT NOT NULL,
  fire_at         TIMESTAMPTZ NOT NULL,
  next_fire_at    TIMESTAMPTZ,
  recurrence      TEXT,
  tags            TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at    TIMESTAMPTZ,
  dismissed_at    TIMESTAMPTZ,
  snoozed_until   TIMESTAMPTZ,
  source          TEXT
);
CREATE INDEX IF NOT EXISTS reminders_user_fire_idx
  ON nudge.reminders (user_id, fire_at)
  WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS reminders_next_fire_idx
  ON nudge.reminders (next_fire_at)
  WHERE dismissed_at IS NULL AND next_fire_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS nudge.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS nudge_api_clients_user_idx
  ON nudge.api_clients (user_id);

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
    INSERT INTO nudge.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
