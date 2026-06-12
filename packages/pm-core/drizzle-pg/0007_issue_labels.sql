-- PM Phase 3b: free-form issue labels (tags).
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0007_issue_labels.sql
--
-- ADDITIVE + idempotent. Per-project labels with a color, plus an issue↔label
-- join. Distinct from `issue_categories` (single-select, per-project) — labels
-- are many-per-issue, free-form tags.

SET search_path = pm, public;

CREATE TABLE IF NOT EXISTS pm.labels (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES pm.projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#6b7280'
);
CREATE UNIQUE INDEX IF NOT EXISTS labels_project_name_idx ON pm.labels (project_id, name);
CREATE INDEX IF NOT EXISTS labels_project_idx ON pm.labels (project_id);

CREATE TABLE IF NOT EXISTS pm.issue_labels (
  issue_id INTEGER NOT NULL REFERENCES pm.issues(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES pm.labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX IF NOT EXISTS issue_labels_label_idx ON pm.issue_labels (label_id);
