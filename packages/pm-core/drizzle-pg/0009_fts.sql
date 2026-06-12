-- PM Phase 3d: Postgres full-text search for issues + wiki.
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0009_fts.sql
--
-- ADDITIVE + idempotent. Replaces the previous LIKE '%q%' scans with GIN-indexed
-- tsvector matching + ts_rank ordering (same pattern as stash/solved). Generated
-- columns use the 2-arg to_tsvector('english', …) form, which is IMMUTABLE (the
-- 1-arg form is only STABLE and can't back a generated column).

SET search_path = pm, public;

ALTER TABLE pm.issues
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(subject, '') || ' ' || coalesce(description, ''))
  ) STORED;
CREATE INDEX IF NOT EXISTS issues_search_tsv_idx ON pm.issues USING GIN (search_tsv);

ALTER TABLE pm.wiki_pages
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, ''))) STORED;
CREATE INDEX IF NOT EXISTS wiki_pages_search_tsv_idx ON pm.wiki_pages USING GIN (search_tsv);

ALTER TABLE pm.wiki_revisions
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce(text, ''))) STORED;
CREATE INDEX IF NOT EXISTS wiki_revisions_search_tsv_idx ON pm.wiki_revisions USING GIN (search_tsv);
