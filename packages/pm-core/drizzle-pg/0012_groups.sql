-- PM logical hierarchy: a single self-referential GROUP TREE of arbitrary depth.
-- A group is an 'organization' or a 'team' (the `kind` label) and any group may
-- contain child groups (org-in-org, team-in-org, … no structural restriction).
-- Projects optionally attach to a group node; membership/roles on any node
-- inherit DOWN to every descendant.
--
-- Fully ADDITIVE + idempotent: new tables and a NULLABLE column only; nothing
-- renamed or dropped. A project-only, group-less deployment is byte-for-byte
-- unaffected (group_id stays NULL and RBAC resolves exactly as before). The
-- legacy projects.auth_team_id column is left untouched.
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0012_groups.sql

SET search_path = pm, public;

CREATE TABLE IF NOT EXISTS pm.groups (
  id SERIAL PRIMARY KEY,
  -- NULL parent = a root group (top of a tenant's tree). Arbitrary nesting.
  -- ON DELETE CASCADE removes an entire subtree with its root.
  parent_id INTEGER REFERENCES pm.groups(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'organization' CHECK (kind IN ('organization', 'team')),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Stable id from an external IdP, used to match membership claims on login.
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Sibling-unique slugs. NULL parent_id rows are distinct under a UNIQUE index in
-- Postgres, so root slugs are NOT enforced unique by this index; a partial
-- unique index covers roots separately.
CREATE UNIQUE INDEX IF NOT EXISTS groups_parent_slug_idx ON pm.groups (parent_id, slug);
CREATE UNIQUE INDEX IF NOT EXISTS groups_root_slug_idx ON pm.groups (slug) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS groups_parent_idx ON pm.groups (parent_id);
CREATE UNIQUE INDEX IF NOT EXISTS groups_external_id_idx ON pm.groups (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pm.group_members (
  id SERIAL PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES pm.groups(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- owner | admin | lead | member
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_idx ON pm.group_members (user_id);

-- Projects may attach to a group node (NULLABLE for legacy rows).
ALTER TABLE pm.projects ADD COLUMN IF NOT EXISTS group_id INTEGER REFERENCES pm.groups(id);
CREATE INDEX IF NOT EXISTS projects_group_idx ON pm.projects (group_id);
