// Database automations + button-property/action execution (Phase 17). Pure
// functions over a postgres.js `Sql` client, mirroring the other handlers.
//
// Storage: editor.db_automations (see drizzle-pg/0013). Button BLOCKS live in
// page content (no table); button PROPERTIES are a db_properties row of
// type='button' whose `config` jsonb holds {label, icon, actions}.
//
// The action vocabulary is shared with the editor package (@allenlabs/editor
// src/lib/actions.ts). Server-side we execute the DATA + side-effect actions:
//   edit_property      — set a db_prop on a row / on all rows of a DB
//   add_page_to        — create a row in a target DB with preset props
//   send_notification  — insert notifications for given recipients
//   send_webhook       — POST a JSON payload to an external URL (guarded)
// `show_confirm` is client-only (skipped server-side). The button-block names
// (add_page_to_db / edit_pages) are normalized to (add_page_to / edit_property)
// so a single executor handles both callers.

import type { Sql } from '../lib/db';
import { addRowImpl, updateRowImpl } from './db';
import { createNotificationImpl } from './notify';

// ---------- shapes ----------

export interface DbAutomation {
  id: string;
  databaseId: string;
  name: string | null;
  enabled: boolean;
  trigger: Record<string, unknown>;
  actions: unknown[];
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

export type TriggerKind = 'page_added' | 'property_edited' | 'schedule';
export type ScheduleEvery = 'day' | 'week' | 'month';

/** A normalized server-executable action (button + automation kinds merged). */
export interface ServerAction {
  kind: string;
  [k: string]: unknown;
}

function jsonb(sql: Sql, value: unknown) {
  return sql.json(value as Parameters<Sql['json']>[0]);
}

// ---------- webhook URL guard ----------

/**
 * True iff `url` is a safe outbound webhook target: http(s) only, and NOT a
 * loopback / link-local / private / metadata address (SSRF guard). Pure +
 * unit-tested. Rejects anything we can't confidently classify.
 */
export function isSafeWebhookUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  // Block obvious names.
  if (host === 'localhost' || host.endsWith('.localhost') || host === '' ) return false;
  // Cloud metadata endpoint (IMDS) — both the IPv4 + the common alias.
  if (host === '169.254.169.254' || host === 'metadata' || host === 'metadata.google.internal') {
    return false;
  }
  // IPv6 loopback / link-local / unique-local.
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return false;
  }
  // IPv4 literal ranges.
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127) return false; // loopback
    if (a === 10) return false; // private
    if (a === 0) return false; // "this host"
    if (a === 169 && b === 254) return false; // link-local
    if (a === 192 && b === 168) return false; // private
    if (a === 172 && b >= 16 && b <= 31) return false; // private
    if (a >= 224) return false; // multicast / reserved
  }
  return true;
}

/** Max webhook body size (bytes) + fetch timeout (ms). */
export const WEBHOOK_MAX_BODY = 64 * 1024;
export const WEBHOOK_TIMEOUT_MS = 5000;

/** Deps the action executor needs beyond `sql` (injectable for tests). */
export interface ActionDeps {
  /** Fetch impl for send_webhook (defaults to global fetch in the route). */
  fetcher: typeof fetch;
  /** Current time, for scheduling math (defaults to Date.now in the route). */
  now?: () => number;
}

// ---------- action normalization ----------

/**
 * Map a raw action (from a button block, button property, or automation) onto
 * the server's canonical names. Returns null for actions we don't execute
 * server-side (show_confirm, insert_blocks, open_page are client-only).
 */
export function normalizeServerAction(raw: unknown): ServerAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const a = raw as Record<string, unknown>;
  switch (a.kind) {
    case 'edit_property':
    case 'edit_pages':
      if (typeof a.propertyId !== 'string') return null;
      return {
        kind: 'edit_property',
        databaseId: typeof a.databaseId === 'string' ? a.databaseId : undefined,
        propertyId: a.propertyId,
        value: a.value,
        currentRowOnly: a.currentRowOnly === undefined ? undefined : Boolean(a.currentRowOnly),
      };
    case 'add_page_to':
    case 'add_page_to_db':
      if (typeof a.databaseId !== 'string') return null;
      return {
        kind: 'add_page_to',
        databaseId: a.databaseId,
        title: typeof a.title === 'string' ? a.title : undefined,
        props: a.props && typeof a.props === 'object' ? a.props : {},
      };
    case 'send_notification': {
      const recipients = Array.isArray(a.recipients)
        ? (a.recipients as unknown[]).filter((r): r is string => typeof r === 'string')
        : [];
      return { kind: 'send_notification', recipients, body: typeof a.body === 'string' ? a.body : '' };
    }
    case 'send_webhook':
      if (typeof a.url !== 'string') return null;
      return {
        kind: 'send_webhook',
        url: a.url,
        payload: a.payload && typeof a.payload === 'object' ? a.payload : {},
      };
    default:
      // insert_blocks / open_page / show_confirm — client-only, no-op here.
      return null;
  }
}

// ---------- action execution ----------

export interface RunActionsInput {
  databaseId: string;
  /** The row in scope (button property / property_edited / page_added). */
  rowId?: string | null;
  actions: unknown[];
  /** Acting user email — notification actor + add_page_to owner. */
  actorEmail: string;
  /** Owner id used when creating rows (add_page_to). Falls back to actorEmail. */
  actorId?: string;
}

export interface RunActionsResult {
  ran: number;
  skipped: number;
  errors: string[];
}

/**
 * Execute an action array server-side. Best-effort: a failing action records an
 * error and the loop continues (callers wrap the whole thing in try/catch for
 * trigger paths so a bad automation never blocks the underlying mutation).
 */
export async function runActionsImpl(
  sql: Sql,
  deps: ActionDeps,
  input: RunActionsInput,
): Promise<RunActionsResult> {
  const result: RunActionsResult = { ran: 0, skipped: 0, errors: [] };
  for (const raw of input.actions ?? []) {
    const action = normalizeServerAction(raw);
    if (!action) {
      result.skipped++;
      continue;
    }
    try {
      await executeOne(sql, deps, input, action);
      result.ran++;
    } catch (e) {
      result.errors.push(`${action.kind}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return result;
}

async function executeOne(
  sql: Sql,
  deps: ActionDeps,
  input: RunActionsInput,
  action: ServerAction,
): Promise<void> {
  switch (action.kind) {
    case 'edit_property': {
      const propertyId = action.propertyId as string;
      const value = action.value;
      // Default to the current row (button property / row trigger). Otherwise
      // edit every (non-archived) row of the target DB.
      const currentRowOnly = action.currentRowOnly !== false; // default true
      if (currentRowOnly && input.rowId) {
        await updateRowImpl(sql, input.rowId, { props: { [propertyId]: value as never } });
        return;
      }
      const dbId = (action.databaseId as string) || input.databaseId;
      const rows = await sql<{ id: string }[]>`
        SELECT id FROM editor.pages
        WHERE database_id = ${dbId} AND archived = false
          AND (is_template IS NOT TRUE)
      `;
      for (const r of rows) {
        await updateRowImpl(sql, r.id, { props: { [propertyId]: value as never } });
      }
      return;
    }
    case 'add_page_to': {
      const dbId = action.databaseId as string;
      const owner = input.actorId || input.actorEmail;
      const created = await addRowImpl(sql, owner, {
        databaseId: dbId,
        title: typeof action.title === 'string' ? action.title : undefined,
      });
      const props = (action.props as Record<string, unknown>) || {};
      if (Object.keys(props).length > 0) {
        await updateRowImpl(sql, created.id, { props: props as never });
      }
      return;
    }
    case 'send_notification': {
      const recipients = (action.recipients as string[]) || [];
      const body = (action.body as string) || '';
      for (const email of recipients) {
        await createNotificationImpl(sql, {
          userEmail: email,
          kind: 'automation',
          actor: input.actorEmail,
          body,
        });
      }
      return;
    }
    case 'send_webhook': {
      const url = action.url as string;
      if (!isSafeWebhookUrl(url)) throw new Error('unsafe url');
      const payload = JSON.stringify({
        databaseId: input.databaseId,
        rowId: input.rowId ?? null,
        ...(action.payload as Record<string, unknown>),
      });
      if (payload.length > WEBHOOK_MAX_BODY) throw new Error('payload too large');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), WEBHOOK_TIMEOUT_MS);
      try {
        await deps.fetcher(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: payload,
          signal: ctrl.signal,
          redirect: 'error',
        });
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    default:
      throw new Error(`unknown action ${action.kind}`);
  }
}

// ---------- automation CRUD ----------

function rowToAutomation(r: {
  id: string;
  databaseId: string;
  name: string | null;
  enabled: boolean;
  trigger: Record<string, unknown>;
  actions: unknown;
  nextRunAt: string | null;
  lastRunAt: string | null;
  createdAt: string;
  createdBy: string | null;
}): DbAutomation {
  return {
    id: r.id,
    databaseId: r.databaseId,
    name: r.name,
    enabled: r.enabled,
    trigger: r.trigger ?? {},
    actions: Array.isArray(r.actions) ? r.actions : [],
    nextRunAt: r.nextRunAt,
    lastRunAt: r.lastRunAt,
    createdAt: r.createdAt,
    createdBy: r.createdBy,
  };
}

const SELECT_COLS = `id, database_id AS "databaseId", name, enabled, trigger, actions,
  next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
  created_at AS "createdAt", created_by AS "createdBy"`;

export async function listAutomationsImpl(sql: Sql, databaseId: string): Promise<DbAutomation[]> {
  const rows = await sql<Parameters<typeof rowToAutomation>[0][]>`
    SELECT id, database_id AS "databaseId", name, enabled, trigger, actions,
      next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
      created_at AS "createdAt", created_by AS "createdBy"
    FROM editor.db_automations
    WHERE database_id = ${databaseId}
    ORDER BY created_at ASC
  `;
  return rows.map(rowToAutomation);
}

/** Resolve the database an automation belongs to (null when not found). */
export async function automationDatabaseImpl(sql: Sql, id: string): Promise<string | null> {
  const [row] = await sql<{ databaseId: string }[]>`
    SELECT database_id AS "databaseId" FROM editor.db_automations WHERE id = ${id} LIMIT 1
  `;
  return row?.databaseId ?? null;
}

export interface CreateAutomationInput {
  databaseId: string;
  name?: string | null;
  trigger: Record<string, unknown>;
  actions: unknown[];
  createdBy?: string | null;
  /** Now (ms) for computing the first scheduled run; defaults to Date.now. */
  now?: () => number;
}

export async function createAutomationImpl(
  sql: Sql,
  input: CreateAutomationInput,
): Promise<DbAutomation> {
  const nextRunAt = computeFirstRun(input.trigger, (input.now ?? Date.now)());
  const [row] = await sql<Parameters<typeof rowToAutomation>[0][]>`
    INSERT INTO editor.db_automations (database_id, name, trigger, actions, next_run_at, created_by)
    VALUES (${input.databaseId}, ${input.name ?? null}, ${jsonb(sql, input.trigger)},
            ${jsonb(sql, input.actions)}, ${nextRunAt}, ${input.createdBy ?? null})
    RETURNING id, database_id AS "databaseId", name, enabled, trigger, actions,
      next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
      created_at AS "createdAt", created_by AS "createdBy"
  `;
  if (!row) throw new Error('createAutomationImpl: insert returned no row');
  return rowToAutomation(row);
}

export interface UpdateAutomationInput {
  name?: string | null;
  trigger?: Record<string, unknown>;
  actions?: unknown[];
  now?: () => number;
}

export async function updateAutomationImpl(
  sql: Sql,
  id: string,
  patch: UpdateAutomationInput,
): Promise<boolean> {
  const assign: Record<string, unknown> = {};
  const cols: string[] = [];
  if (patch.name !== undefined) {
    assign.name = patch.name;
    cols.push('name');
  }
  if (patch.trigger !== undefined) {
    assign.trigger = jsonb(sql, patch.trigger);
    cols.push('trigger');
    // Recompute the next scheduled run when the trigger changes.
    assign.next_run_at = computeFirstRun(patch.trigger, (patch.now ?? Date.now)());
    cols.push('next_run_at');
  }
  if (patch.actions !== undefined) {
    assign.actions = jsonb(sql, patch.actions);
    cols.push('actions');
  }
  if (cols.length === 0) {
    return (await automationDatabaseImpl(sql, id)) !== null;
  }
  const rows = await sql`
    UPDATE editor.db_automations SET ${sql(assign, ...cols)} WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

export async function setEnabledImpl(sql: Sql, id: string, enabled: boolean): Promise<boolean> {
  const rows = await sql`
    UPDATE editor.db_automations SET enabled = ${enabled} WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

export async function deleteAutomationImpl(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM editor.db_automations WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------- trigger evaluation ----------

/**
 * True iff a `property_edited` automation's trigger matches the changed property
 * (+ optional condition). Pure so it's unit-tested. Condition v1 supports
 * `{ equals }` / `{ notEmpty: true }` against the new value.
 */
export function triggerMatchesPropertyEdit(
  trigger: Record<string, unknown>,
  changedPropertyId: string | undefined,
  newValue?: unknown,
): boolean {
  if (trigger.kind !== 'property_edited') return false;
  // No propertyId on the trigger = match ANY property edit.
  if (typeof trigger.propertyId === 'string' && trigger.propertyId !== changedPropertyId) {
    return false;
  }
  const cond = trigger.condition as Record<string, unknown> | undefined;
  if (!cond) return true;
  if ('equals' in cond) return newValue === cond.equals;
  if (cond.notEmpty === true) {
    return newValue !== undefined && newValue !== null && newValue !== '';
  }
  return true;
}

export interface RunTriggerInput {
  databaseId: string;
  event: 'page_added' | 'property_edited';
  rowId: string;
  changedPropertyId?: string;
  newValue?: unknown;
  actorEmail: string;
  actorId?: string;
}

/**
 * Find enabled automations on the database whose trigger matches the event and
 * run their actions. Best-effort: the caller wraps this in try/catch so a bad
 * automation never blocks the row mutation.
 */
export async function runDatabaseTriggerImpl(
  sql: Sql,
  deps: ActionDeps,
  input: RunTriggerInput,
): Promise<number> {
  const autos = await listAutomationsImpl(sql, input.databaseId);
  let fired = 0;
  for (const a of autos) {
    if (!a.enabled) continue;
    const kind = a.trigger.kind;
    let match = false;
    if (input.event === 'page_added' && kind === 'page_added') match = true;
    if (input.event === 'property_edited') {
      match = triggerMatchesPropertyEdit(a.trigger, input.changedPropertyId, input.newValue);
    }
    if (!match) continue;
    await runActionsImpl(sql, deps, {
      databaseId: input.databaseId,
      rowId: input.rowId,
      actions: a.actions,
      actorEmail: input.actorEmail,
      actorId: input.actorId,
    });
    fired++;
  }
  return fired;
}

// ---------- scheduled automations ----------

/**
 * Compute the next run timestamp (ISO) for a trigger, given `nowMs`. Returns
 * null for non-schedule triggers. Advances to the next occurrence of `at`
 * (HH:MM, default 09:00) on the cadence; if today's time already passed, rolls
 * to the next day, else uses today. Pure so it's unit-tested.
 */
export function computeFirstRun(trigger: Record<string, unknown>, nowMs: number): string | null {
  if (trigger.kind !== 'schedule') return null;
  const at = typeof trigger.at === 'string' ? trigger.at : '09:00';
  const [hh, mm] = at.split(':').map((x) => Number(x));
  const now = new Date(nowMs);
  const next = new Date(now);
  next.setUTCHours(Number.isFinite(hh) ? hh! : 9, Number.isFinite(mm) ? mm! : 0, 0, 0);
  if (next.getTime() <= nowMs) {
    // Today's slot passed → first run is tomorrow at the slot.
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

/**
 * Advance a `schedule` trigger's next_run_at by its cadence from `fromMs`. Pure.
 * day → +1 day, week → +7 days, month → +1 calendar month (UTC).
 */
export function advanceSchedule(every: ScheduleEvery, fromMs: number): string {
  const d = new Date(fromMs);
  if (every === 'day') d.setUTCDate(d.getUTCDate() + 1);
  else if (every === 'week') d.setUTCDate(d.getUTCDate() + 7);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString();
}

/** Enabled schedule automations whose next_run_at has passed. */
export async function dueScheduledAutomationsImpl(
  sql: Sql,
  nowIso: string,
): Promise<DbAutomation[]> {
  const rows = await sql<Parameters<typeof rowToAutomation>[0][]>`
    SELECT id, database_id AS "databaseId", name, enabled, trigger, actions,
      next_run_at AS "nextRunAt", last_run_at AS "lastRunAt",
      created_at AS "createdAt", created_by AS "createdBy"
    FROM editor.db_automations
    WHERE enabled = true AND next_run_at IS NOT NULL AND next_run_at <= ${nowIso}
  `;
  return rows.map(rowToAutomation);
}

/**
 * Run all due scheduled automations: execute their actions, set last_run_at, and
 * advance next_run_at by the cadence. Returns how many fired. Best-effort per
 * automation (one failure doesn't abort the batch). `actorEmail` is the system
 * actor for any notifications created.
 */
export async function runScheduledAutomationsImpl(
  sql: Sql,
  deps: ActionDeps,
  nowIso: string,
  actorEmail = 'system',
): Promise<number> {
  const due = await dueScheduledAutomationsImpl(sql, nowIso);
  const nowMs = Date.parse(nowIso);
  let fired = 0;
  for (const a of due) {
    try {
      await runActionsImpl(sql, deps, {
        databaseId: a.databaseId,
        actions: a.actions,
        actorEmail,
      });
    } catch {
      // best-effort — still advance the schedule so we don't busy-loop.
    }
    const every = (a.trigger.every as ScheduleEvery) || 'day';
    const nextRunAt = advanceSchedule(every, nowMs);
    await sql`
      UPDATE editor.db_automations
      SET last_run_at = ${nowIso}, next_run_at = ${nextRunAt}
      WHERE id = ${a.id}
    `;
    fired++;
  }
  return fired;
}
