-- PM Phase 3a: Jira-style issue keys (RED-1).
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0006_issue_keys.sql
--
-- ADDITIVE + idempotent. Adds:
--   * pm.projects.key       — short uppercase project code (e.g. RED). Backfilled
--                             from the identifier; the global #id stays the PK.
--   * pm.projects.issue_seq — per-project monotonic counter for issue numbers.
--   * pm.issues.number      — per-project sequential number (RED-1, RED-2 …).
--                             UNIQUE (project_id, number). The global #id remains
--                             the stable permalink/PK; `number` is display-only.
--
-- Existing reads keep working: nothing drops, and the human key is composed in
-- the app layer as `${key}-${number}`.

SET search_path = pm, public;

-- ---------- projects.key ----------
ALTER TABLE pm.projects ADD COLUMN IF NOT EXISTS key TEXT;

-- Backfill: uppercase alnum of the identifier, capped at 5 chars, 'PRJ' on
-- empty. Collisions among freshly-backfilled rows get a numeric suffix so the
-- unique index below always succeeds. Set-based + idempotent (only NULL keys).
WITH cand AS (
  SELECT
    id,
    CASE
      WHEN regexp_replace(upper(identifier), '[^A-Z0-9]', '', 'g') = '' THEN 'PRJ'
      ELSE left(regexp_replace(upper(identifier), '[^A-Z0-9]', '', 'g'), 5)
    END AS base
  FROM pm.projects
  WHERE key IS NULL
),
ranked AS (
  SELECT id, base, row_number() OVER (PARTITION BY base ORDER BY id) AS rn
  FROM cand
)
UPDATE pm.projects p
SET key = CASE WHEN r.rn = 1 THEN r.base ELSE left(r.base, 4) || r.rn::text END
FROM ranked r
WHERE r.id = p.id;

ALTER TABLE pm.projects ALTER COLUMN key SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS projects_key_idx ON pm.projects (key);

-- ---------- per-project issue counter ----------
ALTER TABLE pm.projects ADD COLUMN IF NOT EXISTS issue_seq INTEGER NOT NULL DEFAULT 0;

-- ---------- issues.number ----------
ALTER TABLE pm.issues ADD COLUMN IF NOT EXISTS number INTEGER;

-- Backfill per-project numbers ordered by id (preserves chronological order).
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY project_id ORDER BY id) AS rn
  FROM pm.issues
)
UPDATE pm.issues i
SET number = numbered.rn
FROM numbered
WHERE numbered.id = i.id AND i.number IS NULL;

-- Advance each project's counter past its highest existing issue number.
UPDATE pm.projects p
SET issue_seq = COALESCE((SELECT max(number) FROM pm.issues i WHERE i.project_id = p.id), 0)
WHERE issue_seq = 0;

ALTER TABLE pm.issues ALTER COLUMN number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS issues_project_number_idx ON pm.issues (project_id, number);
