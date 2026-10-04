-- Phase 16: backlinks / linked references, notification inbox, @date reminders,
-- and comment reactions + @mentions-in-comments. Idempotent (IF NOT EXISTS
-- everywhere) so re-running against an already-migrated DB is a no-op.

-- ---------- A. backlinks / linked references ----------
-- The backlink graph: one row per (source_page → target_page) reference, where
-- a reference is a page-mention node, an inline child-page block, or a /p/<id>
-- link inside the source's saved snapshot_html. Reconciled on every save.
CREATE TABLE IF NOT EXISTS editor.page_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_page_id uuid NOT NULL,
  target_page_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_page_id, target_page_id)
);

CREATE INDEX IF NOT EXISTS page_links_target_idx ON editor.page_links(target_page_id);

-- ---------- B. notification inbox ----------
-- kind ∈ mention | comment | reminder | reaction. user_email is the per-user
-- identity (the SSO email when present, else the user id — the same identity
-- thread the rest of the app uses for attribution).
CREATE TABLE IF NOT EXISTS editor.notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_email text NOT NULL,
  kind text NOT NULL,
  page_id uuid,
  comment_id uuid,
  actor text,
  body text,
  read boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_inbox_idx
  ON editor.notifications(user_email, read, created_at DESC);

-- ---------- C. @date reminders ----------
CREATE TABLE IF NOT EXISTS editor.reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  page_id uuid NOT NULL,
  user_email text NOT NULL,
  remind_at timestamptz NOT NULL,
  body text,
  fired boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reminders_due_idx ON editor.reminders(fired, remind_at);

-- ---------- D. comment reactions ----------
CREATE TABLE IF NOT EXISTS editor.comment_reactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  comment_id uuid NOT NULL,
  user_email text NOT NULL,
  emoji text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_id, user_email, emoji)
);

CREATE INDEX IF NOT EXISTS comment_reactions_comment_idx
  ON editor.comment_reactions(comment_id);

-- D. @mentions-in-comments: emails @-mentioned in the comment body.
ALTER TABLE editor.comments ADD COLUMN IF NOT EXISTS mentions text[];
