-- Initial schema for Stash (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Frictionless snippet/note vault for ADHD developers.  Paste code, commands,
-- mental notes; recall by tag or full-text search.  External working memory.
--
-- Lives in the shared allenlabs DB under the `stash` schema.

CREATE SCHEMA IF NOT EXISTS stash;
SET search_path = stash, public;

-- pgcrypto for the api_clients seed below (`gen_random_bytes`).  Same
-- dynamic-schema lookup as context/focus/inbox — pgcrypto may already live
-- in a different schema on a shared DB.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA stash';
  END IF;
END $$;

-- IMMUTABLE wrapper for array_to_string.  Postgres' built-in array_to_string
-- is marked STABLE (collation considerations on join), so generated columns
-- can't reference it directly.  We need the immutable variant for the
-- search_tsv STORED column.
CREATE OR REPLACE FUNCTION stash.imm_join_tags(text[])
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_to_string($1, ' ');
$$;

-- ---------- Snippets ----------
-- One row per saved snippet.  `search_tsv` is a STORED generated column so
-- both INSERT and UPDATE keep it in sync without an extra trigger; the GIN
-- index over it powers `plainto_tsquery('english', $q)` lookups in
-- `searchSnippetsImpl`.
CREATE TABLE IF NOT EXISTS stash.snippets (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,                            -- soft FK to pm.users.id
  title      TEXT,
  body       TEXT NOT NULL,
  language   TEXT,                                       -- 'sh' | 'js' | 'sql' | 'md' | ...
  tags       TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  source     TEXT,                                       -- 'web' | 'cli' | 'api'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', body), 'B') ||
    setweight(to_tsvector('english', stash.imm_join_tags(tags)), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS snippets_user_created_idx
  ON stash.snippets (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS snippets_tags_idx
  ON stash.snippets USING GIN (tags);
CREATE INDEX IF NOT EXISTS snippets_search_idx
  ON stash.snippets USING GIN (search_tsv);

-- ---------- API clients ----------
-- HMAC-authenticated programmatic clients.  Mirrors inbox/focus/context
-- api_clients exactly so the same signing scheme works across apps.
CREATE TABLE IF NOT EXISTS stash.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,                             -- 32 random bytes, base64
  user_id     BIGINT NOT NULL,                           -- soft FK to pm.users.id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_clients_user_idx
  ON stash.api_clients (user_id);

-- Seed the CLI api_clients row.  Same dynamic pgcrypto lookup as context.
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
    INSERT INTO stash.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
