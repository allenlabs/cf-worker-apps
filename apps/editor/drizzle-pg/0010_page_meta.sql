-- Phase 14: per-page presentation + lock metadata.
--
--   full_width — when true the page container widens (renders edge-to-edge).
--   locked     — when true the page is read-only for EVERYONE (editor/title/
--                icon read-only, DatabaseView read-only). Enforced on the
--                backend: canEditPageImpl treats a locked page as non-editable
--                EXCEPT the unlock toggle (/v1/pages/set-locked) itself.

ALTER TABLE editor.pages ADD COLUMN IF NOT EXISTS full_width boolean NOT NULL DEFAULT false;
ALTER TABLE editor.pages ADD COLUMN IF NOT EXISTS locked boolean NOT NULL DEFAULT false;
