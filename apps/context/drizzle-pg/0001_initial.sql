-- Initial schema for Context (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- "What was I doing?" recovery for ADHD developers.  Save snapshots of the
-- working context (cwd, git branch, open files, tmux windows, browser tabs,
-- focus task, free-text notes), restore them later.  The killer feature is
-- the restore — picks up the user's emotional thread instantly after an
-- interruption.
--
-- Lives in the shared allenlabs DB under the `context` schema.

CREATE SCHEMA IF NOT EXISTS context;
SET search_path = context, public;

-- pgcrypto for the api_clients seed below (`gen_random_bytes`).  On a
-- fresh DB we install it into the context schema; on a shared DB where
-- pgcrypto is already present under another schema (notion_gateway,
-- public, …) we just rely on it being callable by qualified name.  The
-- seed INSERT at the bottom uses a small inline PL/pgSQL block that
-- finds the extension's schema and EXECUTEs the call dynamically.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    EXECUTE 'CREATE EXTENSION pgcrypto WITH SCHEMA context';
  END IF;
END $$;

-- ---------- Snapshots ----------
-- One row per captured context.  The CLI POSTs `name` + `notes?` + `payload`
-- (an arbitrary JSON blob — we render whichever keys we recognise) plus
-- optional soft FKs to the focus session / PM issue / inbox item active at
-- capture time so the restore view can deep-link back into those apps.
CREATE TABLE IF NOT EXISTS context.snapshots (
  id                BIGSERIAL PRIMARY KEY,
  user_id           INTEGER NOT NULL,                       -- soft FK to pm.users.id
  name              TEXT NOT NULL,                          -- user-supplied, e.g. 'fixing auth bug'
  notes             TEXT,                                   -- free-form, mostly written by future self
  -- The snapshot payload.  Schema-less so the CLI can throw arbitrary
  -- captured state in: cwd, branch, files[], processes[], tabs[], …
  -- We render whichever keys we recognise.
  payload           JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The focus task ID at capture time (if any), and the inbox item or
  -- PM issue most recently captured.  Soft FKs, used to surface those
  -- entities in the restore view.
  focus_session_id  BIGINT,
  pm_issue_id       INTEGER,
  inbox_item_id     BIGINT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- For restore counting and dust-collection display:
  restored_at       TIMESTAMPTZ,
  restored_count    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS snapshots_user_created_idx
  ON context.snapshots (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS snapshots_user_name_idx
  ON context.snapshots (user_id, name);

-- ---------- API clients ----------
-- HMAC-authenticated programmatic clients.  Mirrors inbox.api_clients +
-- focus.api_clients exactly so the same signing scheme works across apps.
-- Seed a `cli` row for user_id = 1 so `al ctx save <name>` works out of the
-- box on a fresh deploy.
CREATE TABLE IF NOT EXISTS context.api_clients (
  id          BIGSERIAL PRIMARY KEY,
  client_id   TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,                                -- 32 random bytes, base64
  user_id     INTEGER NOT NULL,                             -- soft FK to pm.users.id
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS api_clients_user_idx
  ON context.api_clients (user_id);

-- Seed the CLI api_clients row.  pgcrypto's `gen_random_bytes` may live in
-- ANY schema on this DB (we don't control that on a shared instance), so
-- we look up its real schema and EXECUTE the seed dynamically.
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
    INSERT INTO context.api_clients (client_id, name, hmac_secret, user_id)
    VALUES ('cli', 'Allen Labs CLI', encode(%I.gen_random_bytes(32), 'base64'), 1)
    ON CONFLICT (client_id) DO NOTHING
  $f$, ext_schema);
END $$;
