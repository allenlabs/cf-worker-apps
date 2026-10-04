// Inbox impls.  All write paths land here so they're testable on PGlite
// (no Hyperdrive, no TanStack Start runtime) and re-exported from both the
// web worker route handlers + the HMAC API worker.

import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { items } from '~/db/schema';

// ---------- Validation ----------

export const SOURCES = ['web', 'cli', 'ext', 'email', 'mobile'] as const;
export type Source = (typeof SOURCES)[number];

export const STATUSES = ['unread', 'pinned', 'done', 'dropped', 'snoozed'] as const;
export type Status = (typeof STATUSES)[number];

// Triage transitions you can perform from the keyboard.  Pin/done/drop are
// terminal-ish; snoozed needs `snoozedUntil` set.
export const TRIAGE_ACTIONS = [
  'pin',
  'unread',
  'done',
  'drop',
  'snooze1d',
  'snooze1w',
  'refile_pm_placeholder',
] as const;
export type TriageAction = (typeof TRIAGE_ACTIONS)[number];

export const captureSchema = z.object({
  text: z.string().min(1).max(8000),
  source: z.enum(SOURCES).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
});
export type CaptureInput = z.infer<typeof captureSchema>;

// Internal write shape — source widened to any string so the API worker
// can stamp the client_id even when it's not in our canonical enum (CLI
// builds shipped before we added 'cli' to SOURCES, third-party clients,
// etc.).
export interface CaptureWrite {
  text: string;
  source?: string | null;
  tags?: string[];
}

// ---------- Capture ----------

export interface CaptureResult {
  id: number;
  capturedAt: Date;
}

export async function captureImpl(
  db: DB,
  userId: number,
  input: CaptureWrite,
): Promise<CaptureResult> {
  const [created] = await db
    .insert(items)
    .values({
      userId,
      text: input.text,
      source: input.source ?? null,
      tags: input.tags ?? [],
    })
    .returning({ id: items.id, capturedAt: items.capturedAt });
  /* v8 ignore next — defensive: drizzle's RETURNING always yields one row
     on a successful INSERT.  An empty array would mean an outright driver
     bug, not a normal failure mode. */
  if (!created) throw new Error('captureImpl: insert returned no row');
  return created;
}

// ---------- List (triage payload) ----------

export interface RefiledTo {
  app?: string;
  placeholder?: boolean;
  issueId?: number;
}

export interface TriageItem {
  id: number;
  text: string;
  source: string | null;
  tags: string[];
  status: Status;
  snoozedUntil: string | null;
  refiledTo: RefiledTo | null;
  capturedAt: string;
}

export interface TriagePayload {
  me: { id: number; login: string };
  unread: TriageItem[];
  pinned: TriageItem[];
  snoozed: TriageItem[];
  done: TriageItem[];
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch;
     the plain-array path is exercised in production by postgres.js. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback; never hit in real
     queries.  Defensive so a partial result can't crash the loader. */
  return Array.isArray(rows) ? rows : [];
}

/**
 * Single CTE loader.  Resolves the current user (via JWT sub) and groups
 * their items by triage bucket in ONE Hetzner round-trip.  We surface
 * snoozed items separately so the UI can show "wakes back up at …".
 */
export async function loadTriageImpl(
  db: DB,
  sub: string | null,
): Promise<TriagePayload | null> {
  if (!sub) return null;
  const result = (await db.execute(
    sql`
      WITH
      me AS (
        SELECT id, login FROM pm.users
        WHERE better_auth_user_id = ${sub} AND status = 'active'
        LIMIT 1
      ),
      my_items AS (
        SELECT
          i.id,
          i.text,
          i.source,
          i.tags,
          i.status,
          i.snoozed_until AS "snoozedUntil",
          i.refiled_to    AS "refiledTo",
          i.captured_at   AS "capturedAt"
        FROM inbox.items i
        WHERE i.user_id = (SELECT id FROM me)
          AND i.status <> 'dropped'
        ORDER BY i.captured_at DESC
        LIMIT 500
      )
      SELECT json_build_object(
        'me',     (SELECT row_to_json(me) FROM me),
        'unread',  COALESCE((SELECT json_agg(t) FROM my_items t WHERE t.status = 'unread'),  '[]'::json),
        'pinned',  COALESCE((SELECT json_agg(t) FROM my_items t WHERE t.status = 'pinned'),  '[]'::json),
        'snoozed', COALESCE((SELECT json_agg(t) FROM my_items t WHERE t.status = 'snoozed'), '[]'::json),
        'done',    COALESCE((SELECT json_agg(t) FROM my_items t WHERE t.status = 'done'),    '[]'::json)
      ) AS data
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  const data = (first as { data?: TriagePayload & { me: TriagePayload['me'] | null } } | undefined)?.data;
  if (!data?.me) return null;
  return {
    me: data.me,
    unread: data.unread,
    pinned: data.pinned,
    snoozed: data.snoozed,
    done: data.done,
  };
}

// ---------- Transitions ----------

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TriageActionInput {
  id: number;
  action: TriageAction;
}

/**
 * Apply a single keyboard-driven transition to one item.  Always scoped
 * by user_id so a forged item id from one user can't mutate another's
 * inbox row.  Returns the updated item (or null if no row matched, e.g.
 * the user no longer owns it).
 */
export async function applyTriageImpl(
  db: DB,
  userId: number,
  input: TriageActionInput,
  now: Date = new Date(),
): Promise<{ id: number; status: Status } | null> {
  // Build the patch.  Each action sets `status` (and sometimes
  // `snoozedUntil` / `refiledTo`); `updatedAt` always advances.
  const patch: {
    status: Status;
    snoozedUntil: Date | null;
    refiledTo: Record<string, unknown> | null | undefined;
    updatedAt: Date;
  } = {
    status: 'unread',
    snoozedUntil: null,
    refiledTo: undefined,
    updatedAt: now,
  };

  switch (input.action) {
    case 'pin':
      patch.status = 'pinned';
      break;
    case 'unread':
      patch.status = 'unread';
      break;
    case 'done':
      patch.status = 'done';
      break;
    case 'drop':
      patch.status = 'dropped';
      break;
    case 'snooze1d':
      patch.status = 'snoozed';
      patch.snoozedUntil = new Date(now.getTime() + DAY_MS);
      break;
    case 'snooze1w':
      patch.status = 'snoozed';
      patch.snoozedUntil = new Date(now.getTime() + 7 * DAY_MS);
      break;
    case 'refile_pm_placeholder':
      // TODO(refile): cross-app POST to pm-web /api/issues w/ project picker.
      // For now just stamp the item so the UI shows a "refiled" badge and
      // the source idea isn't lost.
      patch.status = 'done';
      patch.refiledTo = { app: 'pm', placeholder: true };
      break;
  }

  const updateValues: Record<string, unknown> = {
    status: patch.status,
    snoozedUntil: patch.snoozedUntil,
    updatedAt: patch.updatedAt,
  };
  if (patch.refiledTo !== undefined) {
    updateValues.refiledTo = patch.refiledTo;
  }

  const [updated] = await db
    .update(items)
    .set(updateValues)
    .where(and(eq(items.id, input.id), eq(items.userId, userId)))
    .returning({ id: items.id, status: items.status });
  return updated ?? null;
}

// ---------- List items (flat, filtered by status) ----------
//
// The triage UI loads a single payload via `loadTriageImpl` (grouped by
// bucket).  The CLI (and any future flat-list consumer) wants a flat
// `items[]` filtered by a single status.  Both impls share the same
// underlying table; this one is just a thinner, scoped read.

export interface ListItemsInput {
  /** 'unread' (default), any other Status, or 'all' for everything except
   * 'dropped'. */
  status?: Status | 'all';
  /** Soft cap so a runaway client can't OOM the worker. */
  limit?: number;
}

export interface ListItemsResult {
  items: TriageItem[];
}

export async function listItemsImpl(
  db: DB,
  userId: number,
  input: ListItemsInput = {},
): Promise<ListItemsResult> {
  const status = input.status ?? 'unread';
  const limit = Math.min(Math.max(input.limit ?? 500, 1), 1000);
  // Wrap each row in json_build_object so postgres.js (text protocol, no
  // prepared statements, no type fetching) hands us already-decoded JSON.
  // Otherwise text[] columns come back as the postgres literal `{a,b,c}`
  // which the CLI can't parse.  Mirrors loadTriageImpl's approach.
  const result = (await db.execute(
    status === 'all'
      ? sql`
          SELECT COALESCE(json_agg(t), '[]'::json) AS data FROM (
            SELECT
              id,
              text,
              source,
              tags,
              status,
              snoozed_until AS "snoozedUntil",
              refiled_to    AS "refiledTo",
              captured_at   AS "capturedAt"
            FROM inbox.items
            WHERE user_id = ${userId}
              AND status <> 'dropped'
            ORDER BY captured_at DESC
            LIMIT ${limit}
          ) t
        `
      : sql`
          SELECT COALESCE(json_agg(t), '[]'::json) AS data FROM (
            SELECT
              id,
              text,
              source,
              tags,
              status,
              snoozed_until AS "snoozedUntil",
              refiled_to    AS "refiledTo",
              captured_at   AS "capturedAt"
            FROM inbox.items
            WHERE user_id = ${userId}
              AND status = ${status}
            ORDER BY captured_at DESC
            LIMIT ${limit}
          ) t
        `,
  )) as unknown;
  const [first] = rowsOf(result);
  /* v8 ignore next — `COALESCE(json_agg(t), '[]'::json)` guarantees a
     non-null `data` field on the first (and only) row; the `?? []`
     fallback is defensive only. */
  const data = (first as { data?: TriageItem[] } | undefined)?.data ?? [];
  return { items: data };
}

// ---------- Direct status set (used by /v1/items/:id PATCH) ----------
//
// `applyTriageImpl` is action-driven (pin / done / drop / snooze1d / ...).
// The HTTP API also supports a status-driven shape (status=done|dropped|
// pinned|snoozed[+snoozedUntil]) which matches the on-disk enum directly.
// Both end up touching the same rows; this impl is the thinnest write
// possible.

export interface SetItemStatusInput {
  status: Status;
  /** Required iff status === 'snoozed'. */
  snoozedUntil?: Date | null;
}

export async function setItemStatusImpl(
  db: DB,
  userId: number,
  id: number,
  input: SetItemStatusInput,
  now: Date = new Date(),
): Promise<{ id: number; status: Status; snoozedUntil: Date | null } | null> {
  // For 'snoozed' we want snoozedUntil to be a future ISO timestamp.  If
  // the caller didn't supply one, fall back to 1 day from now (same as
  // applyTriageImpl's `snooze1d`) so we never persist a snooze row with a
  // NULL wake-up.
  const snoozedUntil =
    input.status === 'snoozed'
      ? input.snoozedUntil ?? new Date(now.getTime() + 24 * 60 * 60 * 1000)
      : null;
  const [updated] = await db
    .update(items)
    .set({
      status: input.status,
      snoozedUntil,
      updatedAt: now,
    })
    .where(and(eq(items.id, id), eq(items.userId, userId)))
    .returning({
      id: items.id,
      status: items.status,
      snoozedUntil: items.snoozedUntil,
    });
  return updated ?? null;
}

// ---------- HMAC client lookup (re-exported by the API worker) ----------

export interface ApiClientRow {
  id: number;
  clientId: string;
  name: string;
  hmacSecret: string;
  userId: number;
}

export async function findApiClientImpl(
  db: DB,
  clientId: string,
): Promise<ApiClientRow | null> {
  const rows = (await db.execute(
    sql`
      SELECT id, client_id AS "clientId", name, hmac_secret AS "hmacSecret", user_id AS "userId"
      FROM inbox.api_clients
      WHERE client_id = ${clientId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(rows);
  if (!first) return null;
  return first as ApiClientRow;
}
