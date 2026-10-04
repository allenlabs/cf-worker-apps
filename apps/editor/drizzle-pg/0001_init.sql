-- editor schema: collaborative documents + a small user directory mirror.
--
-- The user directory is upserted on every authed API call from the verified
-- JWT claims the web worker forwards, so /v1/users/search can resolve
-- @-mention suggestions without a cross-app hop to auth.

CREATE SCHEMA IF NOT EXISTS editor;

CREATE TABLE IF NOT EXISTS editor.users (
  user_id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  username text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS editor.documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id text NOT NULL,
  title text NOT NULL DEFAULT 'Untitled',
  snapshot_html text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_owner_idx ON editor.documents(owner_id);
