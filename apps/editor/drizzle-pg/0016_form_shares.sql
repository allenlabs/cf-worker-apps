-- Phase: database Forms (Notion-style form view + public submit).
--
--   editor.form_shares — a publicly-shareable form for a database VIEW
--                        (kind='form'). The presence of an ENABLED row makes
--                        that form's public page reachable signed-out at
--                        /form/<token> and accepts anonymous submissions that
--                        create a row in the database via the same DataSource
--                        path the authenticated UI uses.
--
-- A form's public availability == an enabled form_shares row for its view.
-- Toggling "Share form" in the authoring UI creates / enables / disables the row
-- (never deletes it, so the URL is stable across re-enables). The token is a
-- random urlsafe string minted by the API; it gates the public GET (schema) +
-- POST (submit) routes IN PLACE OF the /v1 HMAC signature.
--
-- The form DEFINITION (title/description/ordered fields/confirmation message)
-- lives in editor.db_views.config jsonb for the kind='form' view — NOT here.
-- This table is only the public-access edge.

CREATE TABLE IF NOT EXISTS editor.form_shares (
  token text PRIMARY KEY,
  database_id uuid NOT NULL REFERENCES editor.pages(id) ON DELETE CASCADE,
  view_id uuid NOT NULL REFERENCES editor.db_views(id) ON DELETE CASCADE,
  enabled boolean NOT NULL DEFAULT true,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS form_shares_database_idx ON editor.form_shares(database_id);
-- One share row per view (the view IS the form); re-toggling flips `enabled`.
CREATE UNIQUE INDEX IF NOT EXISTS form_shares_view_uidx ON editor.form_shares(view_id);
