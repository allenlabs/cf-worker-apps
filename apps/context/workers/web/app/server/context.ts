// Context impls.  All write paths land here so they're testable on PGlite
// (no Hyperdrive, no TanStack Start runtime) and re-exported from both the
// web worker route handlers + the HMAC API worker.

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { snapshots } from '~/db/schema';

// ---------- Validation ----------

// `payload` is intentionally permissive — the CLI captures whatever it
// can (cwd, branch, file lists, tmux windows, …) and we render whichever
// keys we recognise.  We do cap the encoded size to prevent storing
// half-a-million browser tabs by accident.
const PAYLOAD_MAX_BYTES = 256 * 1024;

const jsonObjectSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (v) => {
      try {
        return JSON.stringify(v).length <= PAYLOAD_MAX_BYTES;
      } catch {
        /* v8 ignore next 2 — JSON.stringify only throws on circular refs;
           the CLI never sends those. */
        return false;
      }
    },
    { message: `payload exceeds ${PAYLOAD_MAX_BYTES} bytes` },
  );

export const saveSchema = z.object({
  name: z.string().min(1).max(200),
  notes: z.string().max(8000).optional(),
  payload: jsonObjectSchema.default({}),
  focusSessionId: z.number().int().positive().optional(),
  pmIssueId: z.number().int().positive().optional(),
  inboxItemId: z.number().int().positive().optional(),
});
export type SaveInput = z.infer<typeof saveSchema>;

export const listQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

// ---------- Types ----------

// TanStack Start enforces a serialisable return value for server-fn results.
// `unknown` fails its mapping; use a closed JSON value type that round-trips
// through `JSON.stringify` losslessly.
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [k: string]: JsonValue };

export interface SnapshotSummary {
  id: number;
  name: string;
  createdAt: string;
  restoredAt: string | null;
  restoredCount: number;
  // Cheap preview keys — saves an N+1 to render the home list.
  hasCwd: boolean;
  hasBranch: boolean;
}

export interface SnapshotDetail {
  id: number;
  name: string;
  notes: string | null;
  payload: { [k: string]: JsonValue };
  focusSessionId: number | null;
  pmIssueId: number | null;
  inboxItemId: number | null;
  createdAt: string;
  restoredAt: string | null;
  restoredCount: number;
}

export interface HomePayload {
  me: { id: number; login: string };
  snapshots: SnapshotSummary[];
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch;
     the plain-array path is exercised in production by postgres.js. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString();
  // postgres.js returns ISO-8601 strings directly; pglite's RETURNING path
  // hands back `"YYYY-MM-DD HH:MM:SS+00"`.  Normalise to ISO so callers can
  // compare against `new Date(x).toISOString()` consistently.
  const t = new Date(v).getTime();
  /* v8 ignore next — Date parsing only fails on a malformed string; in
     practice both drivers always produce parseable values. */
  if (!Number.isFinite(t)) return v;
  return new Date(t).toISOString();
}

// ---------- Save ----------

export interface SaveResult {
  id: number;
  name: string;
  createdAt: Date;
}

export async function saveSnapshotImpl(
  db: DB,
  userId: number,
  input: SaveInput,
  now: Date = new Date(),
): Promise<SaveResult> {
  const [created] = await db
    .insert(snapshots)
    .values({
      userId,
      name: input.name,
      notes: input.notes ?? null,
      payload: input.payload,
      focusSessionId: input.focusSessionId ?? null,
      pmIssueId: input.pmIssueId ?? null,
      inboxItemId: input.inboxItemId ?? null,
      createdAt: now,
    })
    .returning({
      id: snapshots.id,
      name: snapshots.name,
      createdAt: snapshots.createdAt,
    });
  /* v8 ignore next — defensive: drizzle's RETURNING always yields one row
     on a successful INSERT.  An empty array would mean an outright driver
     bug, not a normal failure mode. */
  if (!created) throw new Error('saveSnapshotImpl: insert returned no row');
  return { id: created.id, name: created.name, createdAt: created.createdAt };
}

// ---------- List ----------

export async function listSnapshotsImpl(
  db: DB,
  userId: number,
  limit = 20,
): Promise<SnapshotSummary[]> {
  // `payload ? 'cwd'` is the JSONB key-existence operator.  Returns boolean
  // straight from Postgres — no payload round-trip per row.
  const capped = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = (await db.execute(
    sql`
      SELECT
        id,
        name,
        created_at      AS "createdAt",
        restored_at     AS "restoredAt",
        restored_count  AS "restoredCount",
        (payload ? 'cwd')    AS "hasCwd",
        (payload ? 'branch') AS "hasBranch"
      FROM context.snapshots
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${capped}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => {
    const row = r as {
      id: number;
      name: string;
      createdAt: Date | string;
      restoredAt: Date | string | null;
      restoredCount: number | string;
      hasCwd: boolean;
      hasBranch: boolean;
    };
    return {
      id: Number(row.id),
      name: row.name,
      createdAt: toIsoOrNull(row.createdAt)!,
      restoredAt: toIsoOrNull(row.restoredAt),
      /* v8 ignore next — restored_count NOT NULL default 0; defensive only. */
      restoredCount: Number(row.restoredCount ?? 0),
      hasCwd: Boolean(row.hasCwd),
      hasBranch: Boolean(row.hasBranch),
    };
  });
}

// ---------- Get one ----------

export async function getSnapshotImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<SnapshotDetail | null> {
  const result = (await db.execute(
    sql`
      SELECT
        id,
        name,
        notes,
        payload,
        focus_session_id AS "focusSessionId",
        pm_issue_id      AS "pmIssueId",
        inbox_item_id    AS "inboxItemId",
        created_at       AS "createdAt",
        restored_at      AS "restoredAt",
        restored_count   AS "restoredCount"
      FROM context.snapshots
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  const row = first as {
    id: number;
    name: string;
    notes: string | null;
    payload: { [k: string]: JsonValue } | string;
    focusSessionId: number | string | null;
    pmIssueId: number | null;
    inboxItemId: number | string | null;
    createdAt: Date | string;
    restoredAt: Date | string | null;
    restoredCount: number | string;
  };
  // pglite hands back jsonb as a parsed object; postgres.js does the same
  // (driver-level JSON parse for jsonb columns).  Defensive parse if a
  // future driver hands us a string.
  /* v8 ignore next 2 — both drivers we use return a parsed object. */
  const payload =
    typeof row.payload === 'string' ? (JSON.parse(row.payload) as { [k: string]: JsonValue }) : row.payload;
  return {
    id: Number(row.id),
    name: row.name,
    notes: row.notes,
    /* v8 ignore next — `payload` column is NOT NULL with default '{}', so
       the ?? fallback only fires on driver bug. */
    payload: payload ?? {},
    focusSessionId: row.focusSessionId != null ? Number(row.focusSessionId) : null,
    pmIssueId: row.pmIssueId != null ? Number(row.pmIssueId) : null,
    inboxItemId: row.inboxItemId != null ? Number(row.inboxItemId) : null,
    createdAt: toIsoOrNull(row.createdAt)!,
    restoredAt: toIsoOrNull(row.restoredAt),
    /* v8 ignore next — `restored_count` column is NOT NULL with default
       0, so the ?? fallback only fires on driver bug. */
    restoredCount: Number(row.restoredCount ?? 0),
  };
}

// ---------- Restore ----------

/**
 * Bump `restored_at` + `restored_count`.  Returns the (post-bump) detail row
 * so the CLI / browser can render the snapshot in one round-trip.  Scoped by
 * user_id so a forged id can't bump someone else's counter.
 */
export async function restoreSnapshotImpl(
  db: DB,
  userId: number,
  id: number,
  now: Date = new Date(),
): Promise<SnapshotDetail | null> {
  // ISO-8601 string so postgres.js can bind it directly to a timestamptz
  // column under `prepare: false` (its Date adapter only fires when the
  // server tells it the column type up front, which Hyperdrive's pooled
  // simple-query mode doesn't).
  const nowIso = now.toISOString();
  const result = (await db.execute(
    sql`
      UPDATE context.snapshots
      SET restored_at = ${nowIso}::timestamptz, restored_count = restored_count + 1
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING
        id,
        name,
        notes,
        payload,
        focus_session_id AS "focusSessionId",
        pm_issue_id      AS "pmIssueId",
        inbox_item_id    AS "inboxItemId",
        created_at       AS "createdAt",
        restored_at      AS "restoredAt",
        restored_count   AS "restoredCount"
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  const row = first as {
    id: number;
    name: string;
    notes: string | null;
    payload: { [k: string]: JsonValue } | string;
    focusSessionId: number | string | null;
    pmIssueId: number | null;
    inboxItemId: number | string | null;
    createdAt: Date | string;
    restoredAt: Date | string | null;
    restoredCount: number | string;
  };
  /* v8 ignore next 2 — both drivers parse jsonb already. */
  const payload =
    typeof row.payload === 'string' ? (JSON.parse(row.payload) as { [k: string]: JsonValue }) : row.payload;
  return {
    id: Number(row.id),
    name: row.name,
    notes: row.notes,
    /* v8 ignore next — payload column is NOT NULL; defensive only. */
    payload: payload ?? {},
    focusSessionId: row.focusSessionId != null ? Number(row.focusSessionId) : null,
    pmIssueId: row.pmIssueId != null ? Number(row.pmIssueId) : null,
    inboxItemId: row.inboxItemId != null ? Number(row.inboxItemId) : null,
    createdAt: toIsoOrNull(row.createdAt)!,
    restoredAt: toIsoOrNull(row.restoredAt),
    /* v8 ignore next — restored_count NOT NULL default 0; defensive only. */
    restoredCount: Number(row.restoredCount ?? 0),
  };
}

// ---------- Delete ----------

export async function deleteSnapshotImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      DELETE FROM context.snapshots
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

// ---------- Home loader (single CTE) ----------

/**
 * The home page needs:
 *   1. The user (via JWT sub -> pm.users)
 *   2. The user's most-recent 20 snapshots
 *
 * One CTE, one network hop.  Returns null if the JWT is missing or doesn't
 * map to an active pm.users row.
 */
export async function loadHomeImpl(
  db: DB,
  sub: string | null,
  limit = 20,
): Promise<HomePayload | null> {
  if (!sub) return null;
  const capped = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = (await db.execute(
    sql`
      WITH
      me AS (
        SELECT id, login FROM pm.users
        WHERE better_auth_user_id = ${sub} AND status = 'active'
        LIMIT 1
      ),
      my_snapshots AS (
        SELECT
          id,
          name,
          created_at,
          restored_at,
          restored_count,
          (payload ? 'cwd')    AS has_cwd,
          (payload ? 'branch') AS has_branch
        FROM context.snapshots
        WHERE user_id = (SELECT id FROM me)
        ORDER BY created_at DESC
        LIMIT ${capped}
      )
      SELECT json_build_object(
        'me',        (SELECT row_to_json(me) FROM me),
        'snapshots', COALESCE(
          (SELECT json_agg(
              json_build_object(
                'id',            id,
                'name',          name,
                'createdAt',     created_at,
                'restoredAt',    restored_at,
                'restoredCount', restored_count,
                'hasCwd',        has_cwd,
                'hasBranch',     has_branch
              )
              ORDER BY created_at DESC
            ) FROM my_snapshots),
          '[]'::json
        )
      ) AS data
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  const data = (first as {
    data?: {
      me: { id: number; login: string } | null;
      snapshots?: Array<{
        id: number;
        name: string;
        createdAt: string;
        restoredAt: string | null;
        restoredCount: number;
        hasCwd: boolean;
        hasBranch: boolean;
      }>;
    };
  } | undefined)?.data;
  if (!data?.me) return null;
  return {
    me: data.me,
    /* v8 ignore next — `?? []` defensive: the CTE always returns either an
       array or null (COALESCE'd to []). */
    snapshots: (data.snapshots ?? []).map((s) => ({
      id: Number(s.id),
      name: s.name,
      createdAt: toIsoOrNull(s.createdAt)!,
      restoredAt: toIsoOrNull(s.restoredAt),
      /* v8 ignore next — restored_count NOT NULL default 0; defensive only. */
      restoredCount: Number(s.restoredCount ?? 0),
      hasCwd: Boolean(s.hasCwd),
      hasBranch: Boolean(s.hasBranch),
    })),
  };
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
      FROM context.api_clients
      WHERE client_id = ${clientId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(rows);
  if (!first) return null;
  return first as ApiClientRow;
}

// Re-export the snapshots table for tests that need to count rows.
export { snapshots };
