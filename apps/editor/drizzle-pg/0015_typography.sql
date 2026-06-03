-- Phase 18: per-page typography presentation.
--
--   font       — page font family: 'default' | 'serif' | 'mono'. Applied as a
--                class on the page/editor container; purely presentational.
--   small_text — when true the page renders body text one notch smaller.
--
-- Both default to the current presentation (default font, normal text), so
-- existing pages are unchanged. Idempotent (IF NOT EXISTS) — safe to re-run.

ALTER TABLE editor.pages ADD COLUMN IF NOT EXISTS font text NOT NULL DEFAULT 'default';
ALTER TABLE editor.pages ADD COLUMN IF NOT EXISTS small_text boolean NOT NULL DEFAULT false;
