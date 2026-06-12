-- PM Phase 2: team-per-project collaboration on the Allen Labs auth layer.
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0005_pm_phase2.sql
--
-- ADDITIVE + idempotent. Adds:
--   * pm.projects.auth_team_id   — links a PM project to its Better Auth team
--                                  inside org_allenlabs. Nullable so existing
--                                  rows survive; backfilled below for the two
--                                  current projects.
--   * pm.users.username          — public handle synced from the auth user
--                                  (JWT `username`). Nullable.
--   * pm.users.preferred_name    — display name synced from the auth user
--                                  (JWT `preferredName`). Nullable.
--
-- None of these break existing reads: the legacy pm.members RBAC path keeps
-- working, and display falls back to firstname/lastname/login when the new
-- columns are NULL.

SET search_path = pm, public;

ALTER TABLE pm.projects ADD COLUMN IF NOT EXISTS auth_team_id TEXT;
CREATE INDEX IF NOT EXISTS projects_auth_team_id_idx ON pm.projects (auth_team_id);

ALTER TABLE pm.users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE pm.users ADD COLUMN IF NOT EXISTS preferred_name TEXT;

-- Backfill the two existing projects with the teams created in auth D1
-- (org_allenlabs). Team ids are stable; re-running is a no-op for already-set
-- rows because the WHERE guards on the current identifier.
UPDATE pm.projects SET auth_team_id = 'team_1ac336044ed141938e56'
  WHERE identifier = 'my-test-project' AND auth_team_id IS NULL;
UPDATE pm.projects SET auth_team_id = 'team_4b3edbf310d34c0cb836'
  WHERE identifier = 'my-first-project' AND auth_team_id IS NULL;

-- Seed the current user's handle/preferred name from auth (username "allenlim").
UPDATE pm.users SET username = 'allenlim'
  WHERE better_auth_user_id = '2KUUAVv0owg34VbAO4zpxtfhm0kRvKjO' AND username IS NULL;
