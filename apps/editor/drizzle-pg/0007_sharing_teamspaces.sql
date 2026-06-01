-- Phase 9: per-user page sharing ("shared with me") + lightweight teamspaces.
--
--   editor.page_shares — a page shared directly to a single suite user, with a
--                        view|edit role. Access propagates to descendant pages
--                        (the recursive ancestor walk lives in canAccessPageImpl).
--   editor.teamspaces  — a named group of root pages WITHIN a workspace. v1
--                        access == workspace membership (no separate per-teamspace
--                        ACL yet — see the follow-up note in pages.ts).
--   pages.teamspace_id — nullable grouping column; NULL == the default
--                        "Workspace" / "Private" section.

CREATE TABLE IF NOT EXISTS editor.page_shares (
  page_id uuid NOT NULL REFERENCES editor.pages(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL DEFAULT 'view',  -- view|edit
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (page_id, user_id)
);
CREATE INDEX IF NOT EXISTS page_shares_user_idx ON editor.page_shares(user_id);

CREATE TABLE IF NOT EXISTS editor.teamspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES editor.workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Teamspace',
  position double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS teamspaces_ws_idx ON editor.teamspaces(workspace_id);

ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS teamspace_id uuid REFERENCES editor.teamspaces(id) ON DELETE SET NULL;
