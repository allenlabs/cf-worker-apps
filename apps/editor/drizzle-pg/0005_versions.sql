-- Phase 5: page version history.
--
-- Each time /v1/pages/update (or a db row update) writes a NEW snapshot_html
-- that differs from the one currently stored, the PREVIOUS snapshot is first
-- captured here as a version row (author = the user who triggered the change).
-- Writes are throttled (skip if the newest version is < 60s old) so a burst of
-- keystroke-driven snapshots doesn't spam the table, and retention is capped at
-- ~50 versions per page (oldest beyond that are pruned).
--
-- Restore sets the page's snapshot_html back to a chosen version's html (after
-- snapshotting the current state first). NOTE: this is the snapshot-level
-- restore surface only — the live Yjs collab doc is a separate store and is not
-- rewound in v1.

CREATE TABLE IF NOT EXISTS editor.page_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES editor.pages(id) ON DELETE CASCADE,
  snapshot_html text NOT NULL,
  author_id text,
  author_name text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS page_versions_page_idx ON editor.page_versions(page_id, created_at DESC);
