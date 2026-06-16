-- PM single-DB MULTI-SITE: a first-class `site` is the TOP partition, sitting
-- ABOVE the org/group tree. A site is NOT "the root group" — groups (orgs/teams)
-- nest UNDER a site, and a site is administered on its own via site_members.
-- Projects and groups optionally belong to a site (NULLABLE for siteless/legacy
-- single-site deployments). One schema holds every site; there is no
-- schema-per-site / DB-per-site.
--
-- Fully ADDITIVE + idempotent: new tables and NULLABLE columns only. A siteless
-- deployment is byte-for-byte unaffected (site_id stays NULL and RBAC resolves
-- exactly as before). The 0012 global root-slug uniqueness is replaced with a
-- per-site one (root slugs may now repeat across sites).
--
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0013_sites.sql

SET search_path = pm, public;

CREATE TABLE IF NOT EXISTS pm.sites (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  -- Stable id from an external IdP, used to match a site claim on login.
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sites_slug_idx ON pm.sites (slug);
CREATE UNIQUE INDEX IF NOT EXISTS sites_external_id_idx ON pm.sites (external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS pm.site_members (
  id SERIAL PRIMARY KEY,
  site_id INTEGER NOT NULL REFERENCES pm.sites(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member', -- owner | admin | member
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, user_id)
);
CREATE INDEX IF NOT EXISTS site_members_user_idx ON pm.site_members (user_id);

-- Groups (orgs/teams) nest UNDER a site. NULLABLE for siteless/legacy rows.
-- ON DELETE CASCADE removes a site's whole group subtree with the site.
ALTER TABLE pm.groups ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES pm.sites(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS groups_site_idx ON pm.groups (site_id);
-- Root-group slug uniqueness is now PER-SITE (was global in 0012). NULL site_id
-- rows are distinct under the partial unique index, so siteless roots are not
-- constrained against each other (the find-or-create impl dedupes those).
DROP INDEX IF EXISTS pm.groups_root_slug_idx;
CREATE UNIQUE INDEX IF NOT EXISTS groups_site_root_slug_idx ON pm.groups (site_id, slug) WHERE parent_id IS NULL;

-- Projects belong to a site directly (the top partition). NULLABLE for legacy.
ALTER TABLE pm.projects ADD COLUMN IF NOT EXISTS site_id INTEGER REFERENCES pm.sites(id);
CREATE INDEX IF NOT EXISTS projects_site_idx ON pm.projects (site_id);
