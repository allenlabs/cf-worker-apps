-- Phase 3: databases.
--
-- A "database" is just a page with kind='database'. Its rows are ALSO pages
-- (kind='page') whose database_id points back at the database page; each row
-- carries its per-property values in db_props (a jsonb map keyed by property
-- id). A row's title is the page title — the implicit "Name" column — and the
-- row can be opened as a normal page to edit its content (Yjs doc keyed by id).
--
-- Property definitions and saved views live in their own tables, both cascading
-- off the database page. Rows are filtered OUT of the normal page tree (the
-- tree query excludes pages with database_id NOT NULL) so they don't clutter
-- the sidebar — the database page itself DOES show.

ALTER TABLE editor.pages ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'page';   -- 'page' | 'database'
ALTER TABLE editor.pages ADD COLUMN IF NOT EXISTS database_id uuid;                      -- set on rows
ALTER TABLE editor.pages ADD COLUMN IF NOT EXISTS db_props jsonb NOT NULL DEFAULT '{}';  -- row's property values, keyed by property id

CREATE INDEX IF NOT EXISTS pages_database_idx ON editor.pages(database_id) WHERE database_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS editor.db_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id uuid NOT NULL REFERENCES editor.pages(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,                                     -- text|number|checkbox|select|multi_select|status|date|url|email|phone
  config jsonb NOT NULL DEFAULT '{}',                     -- e.g. {options:[{id,name,color}]} for select/status
  position double precision NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS db_properties_database_idx ON editor.db_properties(database_id);

CREATE TABLE IF NOT EXISTS editor.db_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id uuid NOT NULL REFERENCES editor.pages(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Table',
  type text NOT NULL DEFAULT 'table',                     -- table|board (others later)
  config jsonb NOT NULL DEFAULT '{}',                     -- {filters:[],sorts:[],groupBy:propId,visible:[propId...]}
  position double precision NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS db_views_database_idx ON editor.db_views(database_id);
