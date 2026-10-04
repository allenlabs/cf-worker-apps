-- Webhook subscriptions for the Notion Gateway.
-- Apply with: psql "$DATABASE_URL" -f drizzle-pg/0002_webhooks.sql
--
-- Notion's webhook flow has two halves:
--
--   1. Registration: Notion POSTs an unsigned JSON body containing a
--      `verification_token`.  We persist that row with status='pending'
--      and surface the token in the admin UI so the human operator can
--      paste it back into the Notion app form.
--
--   2. Operational events: subsequent POSTs include
--      `X-Notion-Signature: sha256=<hex>` where <hex> is the HMAC-SHA256
--      of the raw body, keyed by the verification token.  We try each
--      pending/verified token in order until one verifies; on first
--      success we flip the row to status='verified'.
--
-- Each `app_clients` row can also register a `webhook_url` to receive
-- translated (PM-shaped) fanout from Notion events.

SET search_path = notion_gateway, public;

CREATE TABLE IF NOT EXISTS notion_gateway.webhook_subscriptions (
  id                  SERIAL PRIMARY KEY,
  verification_token  TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  verified_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE notion_gateway.app_clients
  ADD COLUMN IF NOT EXISTS webhook_url TEXT;
