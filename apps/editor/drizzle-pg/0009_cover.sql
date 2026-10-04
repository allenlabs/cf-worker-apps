-- Phase 11: page cover image.
--
--   pages.cover — an optional banner image URL shown at the top of a page
--                 (uploaded to R2 via the existing /v1/files/upload flow, or a
--                 plain URL). NULL means "no cover".

ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS cover text;
