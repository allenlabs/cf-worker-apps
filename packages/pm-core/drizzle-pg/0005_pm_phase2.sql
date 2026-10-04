-- Add optional auth team and profile fields without deployment-specific seeds.
-- Profile values are synchronized from verified identity claims at sign-in.

SET search_path = pm, public;

ALTER TABLE pm.projects ADD COLUMN IF NOT EXISTS auth_team_id TEXT;
CREATE INDEX IF NOT EXISTS projects_auth_team_id_idx ON pm.projects (auth_team_id);

ALTER TABLE pm.users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE pm.users ADD COLUMN IF NOT EXISTS preferred_name TEXT;
