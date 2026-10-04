-- Phase 17: button blocks, the database button property, and database
-- automations. Idempotent (IF NOT EXISTS everywhere) so re-running against an
-- already-migrated DB is a no-op.
--
-- A. Button BLOCKS need NO table — they live in the page content (Yjs /
--    snapshot_html) as a TipTap `button` node carrying {label, icon, actions}.
-- B. Button PROPERTIES need NO new column — a db_properties row with
--    type='button' stores its {label, icon, actions} in the existing `config`
--    jsonb (same column relation/rollup/formula use).
-- C. Database AUTOMATIONS get their own table below.

-- ---------- C. database automations ----------
-- One row per automation on a database. `trigger` jsonb shapes:
--   { kind:'page_added' }
--   { kind:'property_edited', propertyId, condition? }
--   { kind:'schedule', every:'day'|'week'|'month', at?:'09:00' }
-- `actions` jsonb is an array of action objects (the shared button/automation
-- action schema: edit_property | add_page_to | send_notification | send_webhook
-- | ... ). For `schedule` triggers, `next_run_at` is the next due timestamp the
-- cron picks up; `last_run_at` records the previous fire.
CREATE TABLE IF NOT EXISTS editor.db_automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  database_id uuid NOT NULL,
  name text,
  enabled boolean NOT NULL DEFAULT true,
  trigger jsonb NOT NULL,
  actions jsonb NOT NULL,
  next_run_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text
);

CREATE INDEX IF NOT EXISTS db_automations_database_idx
  ON editor.db_automations(database_id);

-- The cron worker selects due scheduled automations by (enabled, next_run_at).
CREATE INDEX IF NOT EXISTS db_automations_due_idx
  ON editor.db_automations(enabled, next_run_at)
  WHERE next_run_at IS NOT NULL;
