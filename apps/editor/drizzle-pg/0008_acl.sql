-- Phase 10: per-page access control.
--
--   pages.restricted        — when true, a page is NOT visible to all workspace
--                             members. Only the owner + users with an explicit
--                             page_shares row (on this page or an ancestor) can
--                             reach it. Inherited down the subtree by the
--                             recursive access CTE in pageRoleImpl.
--   editor.teamspace_members — opt-in per-teamspace membership. If a teamspace
--                             has ANY member rows, workspace-membership alone no
--                             longer grants access to its pages — the user must
--                             also be a teamspace member. A teamspace with NO
--                             member rows stays open to all workspace members
--                             (back-compat with Phase 9).

ALTER TABLE editor.pages
  ADD COLUMN IF NOT EXISTS restricted boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS editor.teamspace_members (
  teamspace_id uuid NOT NULL REFERENCES editor.teamspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL DEFAULT 'member',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (teamspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS teamspace_members_user_idx ON editor.teamspace_members(user_id);
