-- Phase 1: workspaces + infinitely-nested page tree.
--
-- Evolves the flat editor.documents list into a Notion-style workspace model:
--   editor.workspaces        — a named container owned by one user
--   editor.workspace_members — membership + role (collaboration foundation)
--   editor.pages             — the page tree (parent_id self-reference)
--
-- The existing editor.documents table is LEFT IN PLACE (not dropped) but new
-- code reads/writes editor.pages exclusively. The backfill below migrates each
-- existing document into a per-owner default workspace as a root page,
-- preserving id/title/snapshot so the deployed Yjs docs (keyed by id) keep
-- working unchanged.

CREATE TABLE IF NOT EXISTS editor.workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'My Workspace',
  owner_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS editor.workspace_members (
  workspace_id uuid NOT NULL REFERENCES editor.workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  role text NOT NULL DEFAULT 'owner',
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS editor.pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES editor.workspaces(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES editor.pages(id) ON DELETE CASCADE,
  owner_id text NOT NULL,
  title text NOT NULL DEFAULT 'Untitled',
  icon text,                                      -- emoji or null
  position double precision NOT NULL DEFAULT 0,   -- sibling ordering
  archived boolean NOT NULL DEFAULT false,
  snapshot_html text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pages_ws_idx ON editor.pages(workspace_id) WHERE archived = false;
CREATE INDEX IF NOT EXISTS pages_parent_idx ON editor.pages(parent_id);

-- Backfill: one default workspace per distinct documents.owner_id, then move
-- each existing document into it as a root page (parent_id NULL), preserving
-- id/title/snapshot so existing Yjs docs (keyed by id) keep working.
INSERT INTO editor.workspaces (id, name, owner_id)
  SELECT gen_random_uuid(), 'My Workspace', owner_id FROM (SELECT DISTINCT owner_id FROM editor.documents) d
  ON CONFLICT DO NOTHING;
INSERT INTO editor.workspace_members (workspace_id, user_id, role)
  SELECT id, owner_id, 'owner' FROM editor.workspaces ON CONFLICT DO NOTHING;
INSERT INTO editor.pages (id, workspace_id, parent_id, owner_id, title, snapshot_html, created_at, updated_at)
  SELECT d.id, w.id, NULL, d.owner_id, d.title, d.snapshot_html, d.created_at, d.updated_at
  FROM editor.documents d JOIN editor.workspaces w ON w.owner_id = d.owner_id
  ON CONFLICT (id) DO NOTHING;
