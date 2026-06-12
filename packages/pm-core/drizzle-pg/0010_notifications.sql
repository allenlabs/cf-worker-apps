-- PM Phase 3e: in-app notifications.
-- Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f drizzle-pg/0010_notifications.sql
--
-- ADDITIVE + idempotent. One row per (recipient, issue, event). Display text is
-- composed at read time by joining issues/projects/users, so deleting an issue
-- cascades its notifications away cleanly.

SET search_path = pm, public;

CREATE TABLE IF NOT EXISTS pm.notifications (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES pm.users(id) ON DELETE CASCADE,
  issue_id INTEGER NOT NULL REFERENCES pm.issues(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES pm.users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL, -- assigned | mentioned | commented | updated
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON pm.notifications (user_id, read_at);
CREATE INDEX IF NOT EXISTS notifications_issue_idx ON pm.notifications (issue_id);
