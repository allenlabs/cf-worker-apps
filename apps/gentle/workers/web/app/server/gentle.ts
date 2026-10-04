// Gentle impls.  Testable on PGlite (no Hyperdrive, no TanStack Start runtime).
// Re-exported from both the web worker route handlers + the HMAC API worker.
//
// Design note: this is NOT a habit tracker.  No streaks, no shame.  Missed
// days fade visually but never reset a counter.  The schema has 5 nullable
// boolean toggles + an optional one-line note; upsert is by (user_id, date).

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { checkins } from '~/db/schema';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 1000;

export const checkinSchema = z.object({
  slept_ok: z.boolean().optional().nullable(),
  meds: z.boolean().optional().nullable(),
  ate: z.boolean().optional().nullable(),
  moved: z.boolean().optional().nullable(),
  talked: z.boolean().optional().nullable(),
  note: z.string().max(NOTE_MAX).optional().nullable(),
  date: z.string().regex(DATE_RE).optional(),
});
export type CheckinInput = z.infer<typeof checkinSchema>;

export const rangeQuerySchema = z.object({
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
});
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

export interface CheckinRow {
  id: number;
  userId: number;
  entryDate: string;
  sleptOk: boolean | null;
  meds: boolean | null;
  ate: boolean | null;
  moved: boolean | null;
  talked: boolean | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — pglite returns `{rows:[]}`; postgres.js returns plain array. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  /* v8 ignore next — createdAt/updatedAt are NOT NULL; defensive. */
  if (v == null) return null;
  /* v8 ignore next — pglite returns strings; Date branch fires in production. */
  if (v instanceof Date) return v.toISOString();
  const t = new Date(v).getTime();
  /* v8 ignore next — parseable timestamps in both drivers. */
  if (!Number.isFinite(t)) return v;
  return new Date(t).toISOString();
}

function dateOrIso(v: Date | string | null | undefined): string {
  /* v8 ignore next — entry_date is NOT NULL; defensive. */
  if (v == null) return '';
  /* v8 ignore next — pglite returns strings; Date branch is the postgres.js path. */
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function nullableBool(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v;
  // postgres.js returns 't' / 'f' for boolean columns when fetch_types:false.
  if (typeof v === 'string') {
    if (v === 't' || v === 'true') return true;
    if (v === 'f' || v === 'false') return false;
  }
  /* v8 ignore next — drivers never produce non-string non-boolean values for boolean columns. */
  return null;
}

function rowToCheckin(row: Record<string, unknown>): CheckinRow {
  return {
    id: Number(row.id),
    /* v8 ignore next — every caller aliases user_id AS "userId"; snake-case defensive. */
    userId: Number(row.userId ?? row.user_id),
    entryDate: dateOrIso(row.entryDate as Date | string),
    sleptOk: nullableBool(row.sleptOk),
    meds: nullableBool(row.meds),
    ate: nullableBool(row.ate),
    moved: nullableBool(row.moved),
    talked: nullableBool(row.talked),
    note: (row.note as string | null) ?? null,
    createdAt: toIsoOrNull(row.createdAt as Date | string)!,
    updatedAt: toIsoOrNull(row.updatedAt as Date | string)!,
  };
}

// ---------- Today helpers ----------

function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

// ---------- Upsert ----------

export async function upsertCheckinImpl(
  db: DB,
  userId: number,
  input: CheckinInput,
  now: Date = new Date(),
): Promise<CheckinRow> {
  const entryDate = input.date ?? todayUtc(now);
  const sleptOk = input.slept_ok ?? null;
  const meds = input.meds ?? null;
  const ate = input.ate ?? null;
  const moved = input.moved ?? null;
  const talked = input.talked ?? null;
  const note = input.note ?? null;
  const result = (await db.execute(
    sql`
      INSERT INTO gentle.checkins
        (user_id, entry_date, slept_ok, meds, ate, moved, talked, note, created_at, updated_at)
      VALUES
        (${userId}, ${entryDate}::date, ${sleptOk}, ${meds}, ${ate}, ${moved}, ${talked}, ${note},
         ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
      ON CONFLICT (user_id, entry_date) DO UPDATE
        SET slept_ok = EXCLUDED.slept_ok,
            meds = EXCLUDED.meds,
            ate = EXCLUDED.ate,
            moved = EXCLUDED.moved,
            talked = EXCLUDED.talked,
            note = EXCLUDED.note,
            updated_at = EXCLUDED.updated_at
      RETURNING
        id,
        user_id AS "userId",
        entry_date AS "entryDate",
        slept_ok AS "sleptOk",
        meds, ate, moved, talked, note,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  /* v8 ignore next — RETURNING always yields one row on a successful upsert. */
  if (!first) throw new Error('upsertCheckinImpl: returning produced no row');
  return rowToCheckin(first as Record<string, unknown>);
}

// ---------- Read ----------

export async function getTodayImpl(
  db: DB,
  userId: number,
  now: Date = new Date(),
): Promise<CheckinRow | null> {
  return getByDateImpl(db, userId, todayUtc(now));
}

export async function getByDateImpl(
  db: DB,
  userId: number,
  date: string,
): Promise<CheckinRow | null> {
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id AS "userId",
        entry_date AS "entryDate",
        slept_ok AS "sleptOk",
        meds, ate, moved, talked, note,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM gentle.checkins
      WHERE user_id = ${userId} AND entry_date = ${date}::date
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  return rowToCheckin(first as Record<string, unknown>);
}

export async function listRangeImpl(
  db: DB,
  userId: number,
  from: string,
  to: string,
): Promise<CheckinRow[]> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return [];
  if (to < from) return [];
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id AS "userId",
        entry_date AS "entryDate",
        slept_ok AS "sleptOk",
        meds, ate, moved, talked, note,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM gentle.checkins
      WHERE user_id = ${userId}
        AND entry_date BETWEEN ${from}::date AND ${to}::date
      ORDER BY entry_date DESC
      LIMIT 400
    `,
  )) as unknown;
  return rowsOf(result).map((r) => rowToCheckin(r as Record<string, unknown>));
}

// ---------- Heatmap (90-day) ----------

export interface HeatmapCell {
  date: string;
  /** Count of TRUE toggles for the day, or null when no entry exists. */
  score: number | null;
}

function countTrues(row: CheckinRow): number {
  let n = 0;
  if (row.sleptOk === true) n++;
  if (row.meds === true) n++;
  if (row.ate === true) n++;
  if (row.moved === true) n++;
  if (row.talked === true) n++;
  return n;
}

export async function rangeHeatmapImpl(
  db: DB,
  userId: number,
  from: string,
  to: string,
): Promise<HeatmapCell[]> {
  const rows = await listRangeImpl(db, userId, from, to);
  if (rows.length === 0 && (!DATE_RE.test(from) || !DATE_RE.test(to) || to < from)) {
    return [];
  }
  const byDate = new Map(rows.map((r) => [r.entryDate, r]));
  const start = new Date(`${from}T00:00:00Z`).getTime();
  const end = new Date(`${to}T00:00:00Z`).getTime();
  const cells: HeatmapCell[] = [];
  for (let t = start; t <= end; t += 24 * 60 * 60 * 1000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const row = byDate.get(d);
    cells.push({ date: d, score: row ? countTrues(row) : null });
  }
  return cells;
}

// ---------- Home loader ----------

export interface HomePayload {
  me: { id: number; login: string };
  today: CheckinRow | null;
  /** Last 14 days for a tiny "what's been going on" peek above the heatmap. */
  recent: CheckinRow[];
}

export async function loadHomeImpl(
  db: DB,
  sub: string | null,
  now: Date = new Date(),
): Promise<HomePayload | null> {
  if (!sub) return null;
  const meResult = (await db.execute(
    sql`
      SELECT id, login FROM pm.users
      WHERE better_auth_user_id = ${sub} AND status = 'active'
      LIMIT 1
    `,
  )) as unknown;
  const [meRow] = rowsOf(meResult);
  if (!meRow) return null;
  const me = meRow as { id: number; login: string };
  const today = await getTodayImpl(db, me.id, now);
  const to = todayUtc(now);
  const fromDate = new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().slice(0, 10);
  const recent = await listRangeImpl(db, me.id, from, to);
  return {
    me: { id: Number(me.id), login: me.login },
    today,
    recent,
  };
}

// ---------- HMAC client lookup ----------

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
      FROM gentle.api_clients
      WHERE client_id = ${clientId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(rows);
  if (!first) return null;
  const row = first as ApiClientRow;
  return {
    id: Number(row.id),
    clientId: row.clientId,
    name: row.name,
    hmacSecret: row.hmacSecret,
    userId: Number(row.userId),
  };
}

// ---------- Admin: api-client CRUD ----------

const CLIENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export const createApiClientSchema = z.object({
  clientId: z.string().regex(CLIENT_ID_RE, 'lowercase, digits, _-, 2-64 chars'),
  name: z.string().min(1).max(120),
});
export type CreateApiClientInput = z.infer<typeof createApiClientSchema>;

export interface CreateApiClientResult {
  clientId: string;
  name: string;
  hmacSecret: string;
  createdAt: string;
}

export async function createApiClientImpl(
  db: DB,
  userId: number,
  input: CreateApiClientInput,
  now: Date = new Date(),
): Promise<CreateApiClientResult> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const hmacSecret = btoa(bin);

  await db.execute(sql`
    INSERT INTO gentle.api_clients (client_id, name, hmac_secret, user_id, created_at)
    VALUES (${input.clientId}, ${input.name}, ${hmacSecret}, ${userId}, ${now.toISOString()}::timestamptz)
  `);
  return {
    clientId: input.clientId,
    name: input.name,
    hmacSecret,
    createdAt: now.toISOString(),
  };
}

export interface ApiClientListItem {
  clientId: string;
  name: string;
  createdAt: string;
}

export async function listApiClientsImpl(
  db: DB,
  userId: number,
): Promise<ApiClientListItem[]> {
  const result = (await db.execute(
    sql`
      SELECT client_id AS "clientId", name, created_at AS "createdAt"
      FROM gentle.api_clients
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `,
  )) as unknown;
  return rowsOf(result).map((r) => {
    const row = r as { clientId: string; name: string; createdAt: Date | string };
    return {
      clientId: row.clientId,
      name: row.name,
      createdAt: toIsoOrNull(row.createdAt)!,
    };
  });
}

export async function deleteApiClientImpl(
  db: DB,
  userId: number,
  clientId: string,
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      DELETE FROM gentle.api_clients
      WHERE client_id = ${clientId} AND user_id = ${userId}
      RETURNING client_id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export { checkins };

export const _testing = { nullableBool, rowToCheckin, countTrues };
