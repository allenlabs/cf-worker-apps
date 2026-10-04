-- PM Phase 3c: issue relations (blocks / relates / duplicates / precedes / copied).
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0008_issue_relations.sql
--
-- ADDITIVE + idempotent. One directed row per relation; the inverse direction
-- (blocked / duplicated / follows / copied_from) is derived in the app layer.
-- `relates` is symmetric and stored once.

SET search_path = pm, public;

CREATE TABLE IF NOT EXISTS pm.issue_relations (
  id SERIAL PRIMARY KEY,
  source_issue_id INTEGER NOT NULL REFERENCES pm.issues(id) ON DELETE CASCADE,
  target_issue_id INTEGER NOT NULL REFERENCES pm.issues(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS issue_relations_unique_idx
  ON pm.issue_relations (source_issue_id, target_issue_id, relation_type);
CREATE INDEX IF NOT EXISTS issue_relations_source_idx ON pm.issue_relations (source_issue_id);
CREATE INDEX IF NOT EXISTS issue_relations_target_idx ON pm.issue_relations (target_issue_id);
