-- Notion integration tables (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0003_notion.sql
--
-- Adds one-way PM -> Notion sync support.  `notion_connections` stores
-- the per-project mapping onto a Notion Database; `notion_issue_links`
-- remembers which Notion page mirrors each PM issue so the next sync
-- updates the same page instead of creating duplicates.

SET search_path = pm, public;

-- ---------- Notion connections ----------
CREATE TABLE pm.notion_connections (
  id SERIAL PRIMARY KEY,
  project_id INTEGER NOT NULL UNIQUE REFERENCES pm.projects(id) ON DELETE CASCADE,
  database_id TEXT NOT NULL,
  database_title TEXT NOT NULL,
  mapping JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Notion issue links ----------
CREATE TABLE pm.notion_issue_links (
  issue_id INTEGER NOT NULL REFERENCES pm.issues(id) ON DELETE CASCADE,
  page_id TEXT NOT NULL,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (issue_id)
);
