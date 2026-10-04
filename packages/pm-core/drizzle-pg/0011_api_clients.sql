-- PM Phase 3f: HMAC API clients for the REST API worker.
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0011_api_clients.sql
--
-- ADDITIVE + idempotent. Mirrors the suite's api_clients pattern: one row per
-- client_id with a per-client hmac_secret (rotated via UPDATE) acting on behalf
-- of `user_id`. Secrets live here, not as wrangler secrets.

SET search_path = pm, public;

CREATE TABLE IF NOT EXISTS pm.api_clients (
  id SERIAL PRIMARY KEY,
  client_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  hmac_secret TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS api_clients_user_idx ON pm.api_clients (user_id);
