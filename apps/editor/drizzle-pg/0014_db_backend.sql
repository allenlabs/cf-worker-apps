-- Datasource Step 2: pluggable database backend marker.
--
-- ADDITIVE + NON-DESTRUCTIVE. Every existing database page defaults to
-- 'postgres', so behavior is unchanged — the per-workspace SQLite Durable
-- Object (WorkspaceDB) backend is an OPT-IN alternative recorded as
-- 'native_do' for NEW native databases only. No data is migrated or touched.
--
-- A 'native_do' database keeps a lightweight container/metadata page on this
-- PG table (so the sidebar tree / ACL / search keep working unchanged) while
-- its PROPERTIES / VIEWS / ROWS live in the workspace's WorkspaceDB DO. Only
-- the DataSource (rows/properties/views) is redirected; the full page/tree/ACL
-- re-platform + backfill is Step 3.
--
-- Idempotent (IF NOT EXISTS) so the migration is safe to re-run.

ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS db_backend text NOT NULL DEFAULT 'postgres';

-- Only the database container page rows carry a meaningful backend; rows/normal
-- pages keep the default. A partial index keeps lookups cheap for the resolver.
CREATE INDEX IF NOT EXISTS pages_db_backend_idx
  ON editor.pages(db_backend) WHERE kind = 'database';
