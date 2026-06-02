-- Phase 15: database power features.
--
-- A. Linked database views — a db_view can point at ANOTHER database's rows via
--    source_database_id. The view lives on / is embedded by a different page
--    (the linkedDatabase block) but reads the source DB's rows while keeping its
--    own filters/sorts/group config. NULL == a normal view of its own DB.
--
-- B. Row templates — a hidden page under a DB (is_template=true, template_of=
--    <dbId>) whose db_props + snapshot_html seed new rows. Templates are EXCLUDED
--    from normal row listings.
--
-- C. Sub-items — a row's parent row WITHIN the same database
--    (sub_item_parent_id, distinct from parent_id which is the DB container).
--    Indexed for the tree build. Cycles are prevented in app-space.
--
-- E. Wiki / verified pages — is_wiki turns a page into a directory home listing
--    its sub-pages; verified/verified_by/verified_at mark a page as reviewed.
--
-- All idempotent (IF NOT EXISTS) so the migration is safe to re-run.

-- A. linked database views
ALTER TABLE editor.db_views
  ADD COLUMN IF NOT EXISTS source_database_id uuid;

-- B. row templates
ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS is_template boolean NOT NULL DEFAULT false;
ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS template_of uuid;
CREATE INDEX IF NOT EXISTS pages_template_of_idx
  ON editor.pages(template_of) WHERE template_of IS NOT NULL;

-- C. sub-items (hierarchical rows within a database)
ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS sub_item_parent_id uuid REFERENCES editor.pages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS pages_sub_item_parent_idx
  ON editor.pages(sub_item_parent_id) WHERE sub_item_parent_id IS NOT NULL;

-- E. wiki / verified pages
ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS is_wiki boolean NOT NULL DEFAULT false;
ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS verified boolean NOT NULL DEFAULT false;
ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS verified_by text;
ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS verified_at timestamptz;
