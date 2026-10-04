-- Initial schema for Read Later (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Reading queue for ADHD developers.  Capture URLs from anywhere, surface
-- ONE next thing to read, show estimated reading time.  Strip distractions
-- from articles in reader mode.
--
-- Lives in the shared allenlabs DB under the `read_later` schema.

CREATE SCHEMA IF NOT EXISTS read_later;
SET search_path = read_later, public;

-- pgcrypto for the api_clients seed (`gen_random_bytes`).  Same dynamic
-- schema-lookup pattern as inbox / focus / context — on a shared DB we
-- don't control where pgcrypto is installed.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA read_later';
  END IF;
END $$;

-- ---------- Items ----------
-- One row per saved URL.  `content_html` is the Mozilla-Readability-extracted
-- main article body, sanitized.  `word_count` / `estimated_minutes` are
-- precomputed at save time so the queue surface can sort without a scan.
CREATE TABLE IF NOT EXISTS read_later.items (
  id                BIGSERIAL PRIMARY KEY,
  user_id           BIGINT NOT NULL,                       -- soft FK to pm.users.id
  url               TEXT NOT NULL,
  title             TEXT,
  excerpt           TEXT,
  content_html      TEXT,                                  -- reader-mode body (sanitized)
  word_count        INTEGER,
  estimated_minutes INTEGER,                               -- word_count / 220, min 1
  tags              TEXT[] NOT NULL DEFAULT '{}',
  saved_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at           TIMESTAMPTZ,
  skipped_count     INTEGER NOT NULL DEFAULT 0,
  source            TEXT                                   -- 'web' | 'cli' | 'api' | 'inbox'
);
-- Queue surface: unread first (read_at NULL), oldest first.
CREATE INDEX IF NOT EXISTS items_user_unread_saved_idx
  ON read_later.items (user_id, read_at NULLS FIRST, saved_at);
CREATE INDEX IF NOT EXISTS items_tags_gin_idx
  ON read_later.items USING gin (tags);

-- ---------- API clients ----------
-- HMAC-authenticated programmatic clients.  Mirrors inbox / focus / context
-- api_clients exactly so the same signing scheme works across apps.  Seed a
-- `cli` row for user_id = 1 so `al rl save <url>` works out of the box.
CREATE TABLE IF NOT EXISTS read_later.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,                                -- 32 random bytes, base64
  user_id     BIGINT NOT NULL,                              -- soft FK to pm.users.id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_clients_user_idx
  ON read_later.api_clients (user_id);

-- Seed the CLI api_clients row.  Dynamic pgcrypto lookup (same pattern as
-- inbox/focus/context) so this works on a shared DB.
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
    INSERT INTO read_later.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
