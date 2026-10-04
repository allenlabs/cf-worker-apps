-- Initial schema for Solved (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- Searchable personal knowledge base.  Auto-captures fix-style PRs, closed
-- issues, terminal post-mortems.  FTS-only for v1; semantic via Workers AI
-- Vectorize is a future enhancement.
--
-- Lives in the shared allenlabs DB under the `solved` schema.

CREATE SCHEMA IF NOT EXISTS solved;
SET search_path = solved, public;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA solved';
  END IF;
END $$;

-- IMMUTABLE wrapper for array_to_string.  Same rationale as stash: the
-- built-in is STABLE so generated columns can't call it directly.
CREATE OR REPLACE FUNCTION solved.imm_join_tags(text[])
RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT array_to_string($1, ' ');
$$;

CREATE TABLE IF NOT EXISTS solved.entries (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  tags        TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  source      TEXT,                                       -- 'pr_merged' | 'issue_closed' | 'cli' | 'web' | 'api' | 'notion'
  source_ref  TEXT,                                       -- e.g. 'pm:my-first-project#42'
  source_url  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  search_tsv  TSVECTOR GENERATED ALWAYS AS (
    setweight(to_tsvector('english', COALESCE(title, '')), 'A') ||
    setweight(to_tsvector('english', body), 'B') ||
    setweight(to_tsvector('english', solved.imm_join_tags(tags)), 'C')
  ) STORED
);
CREATE INDEX IF NOT EXISTS solved_entries_user_created_idx
  ON solved.entries (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS solved_entries_tags_idx
  ON solved.entries USING GIN (tags);
CREATE INDEX IF NOT EXISTS solved_entries_search_idx
  ON solved.entries USING GIN (search_tsv);

CREATE TABLE IF NOT EXISTS solved.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  user_id     BIGINT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS solved_api_clients_user_idx
  ON solved.api_clients (user_id);

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
    INSERT INTO solved.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
