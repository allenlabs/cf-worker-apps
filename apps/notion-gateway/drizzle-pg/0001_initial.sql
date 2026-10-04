-- Initial schema for Notion Gateway (Postgres / Hyperdrive)
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0001_initial.sql
--
-- The Notion Gateway is a central service that holds OAuth tokens for
-- one or more Notion workspaces.  Consumer apps (PM, MyPanel, …) talk to
-- the gateway via HMAC-signed JSON over HTTPS and never see Notion
-- tokens themselves.  All DDL targets the `notion_gateway` schema.

CREATE SCHEMA IF NOT EXISTS notion_gateway;
SET search_path = notion_gateway, public;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- Workspaces ----------
-- One row per Notion workspace the gateway has been authorized for.
-- `access_token` is AES-GCM-encrypted at rest with a key derived from the
-- `WORKSPACE_TOKEN_KEY` wrangler secret.
CREATE TABLE IF NOT EXISTS notion_gateway.workspaces (
  id            SERIAL PRIMARY KEY,
  notion_id     TEXT NOT NULL UNIQUE,             -- bot_id from token exchange
  workspace_id  TEXT NOT NULL,                    -- notion workspace UUID
  name          TEXT NOT NULL,
  icon          TEXT,
  owner_email   TEXT,
  access_token  TEXT NOT NULL,                    -- AES-GCM ciphertext (base64)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- App clients ----------
-- One row per consumer app that talks to the gateway.  `hmac_secret` is
-- the shared secret used to sign every request — rotated by UPDATE.
CREATE TABLE IF NOT EXISTS notion_gateway.app_clients (
  id                     SERIAL PRIMARY KEY,
  client_id              TEXT NOT NULL UNIQUE,             -- e.g. 'pm', 'mypanel'
  name                   TEXT NOT NULL,
  hmac_secret            TEXT NOT NULL,                    -- 32 random bytes, base64
  allowed_return_origins JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Connections ----------
-- One row per (consumer app, app-resource) pair.  `app_resource` is opaque
-- to the gateway — it identifies the resource the consumer wants to mirror
-- onto a Notion Database (e.g. `project/42` for PM, `task-list/7` for
-- MyPanel).  The mapping JSON snapshots the Notion property -> consumer
-- field mapping so the push path doesn't need to re-introspect the DB.
CREATE TABLE IF NOT EXISTS notion_gateway.connections (
  id              SERIAL PRIMARY KEY,
  app_client_id   INTEGER NOT NULL REFERENCES notion_gateway.app_clients(id) ON DELETE CASCADE,
  workspace_id    INTEGER NOT NULL REFERENCES notion_gateway.workspaces(id) ON DELETE CASCADE,
  app_resource    TEXT NOT NULL,
  database_id     TEXT NOT NULL,
  database_title  TEXT NOT NULL,
  mapping         JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (app_client_id, app_resource)
);
CREATE INDEX IF NOT EXISTS connections_workspace_idx
  ON notion_gateway.connections (workspace_id);

-- ---------- Page links ----------
-- One row per (connection, app-record) pair.  Remembers which Notion page
-- mirrors each consumer record so subsequent pushes update the same page
-- instead of creating duplicates.
CREATE TABLE IF NOT EXISTS notion_gateway.page_links (
  connection_id   INTEGER NOT NULL REFERENCES notion_gateway.connections(id) ON DELETE CASCADE,
  app_record      TEXT NOT NULL,
  page_id         TEXT NOT NULL,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (connection_id, app_record)
);

-- ---------- OAuth state ----------
-- Short-lived rows that carry consumer-app context across the Notion
-- OAuth dance.  The gateway issues the random `state`, persists the
-- consumer's `return_to` URL, and looks both up on /oauth/callback.
CREATE TABLE IF NOT EXISTS notion_gateway.oauth_state (
  state           TEXT PRIMARY KEY,
  app_client_id   INTEGER NOT NULL REFERENCES notion_gateway.app_clients(id) ON DELETE CASCADE,
  app_resource    TEXT NOT NULL,
  return_to       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_state_expires_at_idx
  ON notion_gateway.oauth_state (expires_at);

-- Seed PM as the first registered client.  The secret value is a random
-- placeholder; rotate it via UPDATE before going to production.
INSERT INTO notion_gateway.app_clients (client_id, name, hmac_secret, allowed_return_origins)
  VALUES ('pm', 'Project Management',
          encode(gen_random_bytes(32), 'base64'),
          '["https://projects.allenlabs.org", "http://localhost:5173"]'::jsonb)
  ON CONFLICT (client_id) DO NOTHING;
