-- Phase 4: collaboration — favorites, page-level comments, public sharing.
--
-- pages.public      — when true, GET /public/page/:id serves a read-only view
--                     with no auth (backs https://editor.allenlabs.org/share/<id>).
-- editor.favorites  — per-user starred pages (composite PK keeps a page starred
--                     at most once per user); cascades when the page is purged.
-- editor.comments   — page-level comment threads (no text anchor yet — that's
--                     deferred to a later phase). author_name is denormalised so
--                     the public/sidebar reads don't need to join editor.users.

ALTER TABLE editor.pages ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS editor.favorites (
  user_id text NOT NULL,
  page_id uuid NOT NULL REFERENCES editor.pages(id) ON DELETE CASCADE,
  position double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, page_id)
);

CREATE TABLE IF NOT EXISTS editor.comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL REFERENCES editor.pages(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  author_name text NOT NULL DEFAULT '',
  body text NOT NULL,
  resolved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS comments_page_idx ON editor.comments(page_id);
CREATE INDEX IF NOT EXISTS favorites_user_idx ON editor.favorites(user_id);
