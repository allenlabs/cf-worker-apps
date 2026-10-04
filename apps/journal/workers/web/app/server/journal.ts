// Journal impls.  Testable on PGlite (no Hyperdrive, no TanStack Start runtime).
// Re-exported from both the web worker route handlers + the HMAC API worker.

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { entries } from '~/db/schema';

const SCORE = z.number().int().min(1).max(5);
const TEXT_MAX = 10_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const checkinSchema = z.object({
  mood: SCORE,
  energy: SCORE,
  focus: SCORE,
  mind: z.string().max(TEXT_MAX).optional().nullable(),
  blockers: z.string().max(TEXT_MAX).optional().nullable(),
  tags: z.array(z.string().min(1).max(64)).max(16).optional(),
  date: z.string().regex(DATE_RE).optional(),
  source: z.string().min(1).max(40).optional(),
});
export type CheckinInput = z.infer<typeof checkinSchema>;

export const rangeQuerySchema = z.object({
  from: z.string().regex(DATE_RE),
  to: z.string().regex(DATE_RE),
});
export type RangeQuery = z.infer<typeof rangeQuerySchema>;

export interface EntryRow {
  id: number;
  userId: number;
  entryDate: string;
  mood: number | null;
  energy: number | null;
  focus: number | null;
  mind: string | null;
  blockers: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  source: string | null;
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — pglite returns `{rows:[]}`; postgres.js returns plain array. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  /* v8 ignore next — createdAt/updatedAt are NOT NULL; null branch is defensive. */
  if (v == null) return null;
  /* v8 ignore next — pglite returns timestamps as strings; Date branch fires in production. */
  if (v instanceof Date) return v.toISOString();
  const t = new Date(v).getTime();
  /* v8 ignore next — parseable timestamps in both drivers. */
  if (!Number.isFinite(t)) return v;
  return new Date(t).toISOString();
}

function dateOrIso(v: Date | string | null | undefined): string {
  /* v8 ignore next — entry_date is NOT NULL; null branch is defensive. */
  if (v == null) return '';
  /* v8 ignore next — pglite hands back strings; Date branch is the postgres.js path. */
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Already yyyy-mm-dd or yyyy-mm-dd HH:MM:SS+00.
  return String(v).slice(0, 10);
}

function normaliseTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter((x): x is string => typeof x === 'string');
  if (typeof input === 'string') return parsePgArrayLiteral(input);
  return [];
}

function parsePgArrayLiteral(s: string): string[] {
  if (s.length < 2 || s[0] !== '{' || s[s.length - 1] !== '}') return [];
  const inner = s.slice(1, -1);
  if (inner === '') return [];
  const out: string[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '"') {
      let buf = '';
      i++;
      while (i < inner.length && inner[i] !== '"') {
        if (inner[i] === '\\' && i + 1 < inner.length) {
          buf += inner[i + 1];
          i += 2;
        } else {
          buf += inner[i];
          i++;
        }
      }
      out.push(buf);
      i++;
      if (inner[i] === ',') i++;
    } else {
      let buf = '';
      while (i < inner.length && inner[i] !== ',') {
        buf += inner[i];
        i++;
      }
      /* v8 ignore next 3 — journal.entries.tags is NOT NULL DEFAULT '{}'. */
      if (buf === 'NULL') {
        out.push('');
      } else {
        out.push(buf);
      }
      if (inner[i] === ',') i++;
    }
  }
  return out;
}

function entryFromRow(row: Record<string, unknown>): EntryRow {
  return {
    id: Number(row.id),
    /* v8 ignore next — every caller aliases user_id AS "userId"; snake-case is defensive. */
    userId: Number(row.userId ?? row.user_id),
    entryDate: dateOrIso(row.entryDate as Date | string),
    mood: row.mood == null ? null : Number(row.mood),
    energy: row.energy == null ? null : Number(row.energy),
    focus: row.focus == null ? null : Number(row.focus),
    mind: (row.mind as string | null) ?? null,
    blockers: (row.blockers as string | null) ?? null,
    tags: normaliseTags(row.tags),
    createdAt: toIsoOrNull(row.createdAt as Date | string)!,
    updatedAt: toIsoOrNull(row.updatedAt as Date | string)!,
    source: (row.source as string | null) ?? null,
  };
}

// ---------- Checkin (upsert by date) ----------

function todayUtc(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export async function upsertCheckinImpl(
  db: DB,
  userId: number,
  input: CheckinInput,
  now: Date = new Date(),
): Promise<EntryRow> {
  const entryDate = input.date ?? todayUtc(now);
  const tags = input.tags ?? [];
  const tagsLiteral =
    '{' +
    tags
      .map((t) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',') +
    '}';
  const result = (await db.execute(
    sql`
      INSERT INTO journal.entries
        (user_id, entry_date, mood, energy, focus, mind, blockers, tags, source, created_at, updated_at)
      VALUES
        (${userId}, ${entryDate}::date, ${input.mood}, ${input.energy}, ${input.focus},
         ${input.mind ?? null}, ${input.blockers ?? null},
         ${tagsLiteral}::text[],
         ${input.source ?? null},
         ${now.toISOString()}::timestamptz, ${now.toISOString()}::timestamptz)
      ON CONFLICT (user_id, entry_date) DO UPDATE
        SET mood = EXCLUDED.mood,
            energy = EXCLUDED.energy,
            focus = EXCLUDED.focus,
            mind = EXCLUDED.mind,
            blockers = EXCLUDED.blockers,
            tags = EXCLUDED.tags,
            source = COALESCE(EXCLUDED.source, journal.entries.source),
            updated_at = EXCLUDED.updated_at
      RETURNING
        id,
        user_id AS "userId",
        entry_date AS "entryDate",
        mood, energy, focus, mind, blockers, tags, source,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  /* v8 ignore next — RETURNING always yields one row on successful upsert. */
  if (!first) throw new Error('upsertCheckinImpl: returning produced no row');
  return entryFromRow(first as Record<string, unknown>);
}

// ---------- Read ----------

export async function getTodayImpl(
  db: DB,
  userId: number,
  now: Date = new Date(),
): Promise<EntryRow | null> {
  return getByDateImpl(db, userId, todayUtc(now));
}

export async function getByDateImpl(
  db: DB,
  userId: number,
  date: string,
): Promise<EntryRow | null> {
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id AS "userId",
        entry_date AS "entryDate",
        mood, energy, focus, mind, blockers, tags, source,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM journal.entries
      WHERE user_id = ${userId} AND entry_date = ${date}::date
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  return entryFromRow(first as Record<string, unknown>);
}

export async function listRangeImpl(
  db: DB,
  userId: number,
  from: string,
  to: string,
): Promise<EntryRow[]> {
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) return [];
  if (to < from) return [];
  const result = (await db.execute(
    sql`
      SELECT
        id,
        user_id AS "userId",
        entry_date AS "entryDate",
        mood, energy, focus, mind, blockers, tags, source,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM journal.entries
      WHERE user_id = ${userId}
        AND entry_date BETWEEN ${from}::date AND ${to}::date
      ORDER BY entry_date DESC
      LIMIT 400
    `,
  )) as unknown;
  return rowsOf(result).map((r) => entryFromRow(r as Record<string, unknown>));
}

// ---------- Stats ----------

export interface JournalStats {
  total: number;
  averages: {
    mood: number | null;
    energy: number | null;
    focus: number | null;
  };
  /** Last 90 days as { date, score|null } so callers can render a heatmap. */
  heatmap: Array<{ date: string; score: number | null }>;
}

export async function statsImpl(
  db: DB,
  userId: number,
  now: Date = new Date(),
): Promise<JournalStats> {
  const to = todayUtc(now);
  const fromDate = new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000);
  const from = fromDate.toISOString().slice(0, 10);
  const rows = await listRangeImpl(db, userId, from, to);
  const byDate = new Map(rows.map((r) => [r.entryDate, r]));
  const heatmap: Array<{ date: string; score: number | null }> = [];
  // Walk every day in the window — missed days render as null (fades, no
  // streak break).
  for (let i = 0; i < 90; i++) {
    const d = new Date(fromDate.getTime() + i * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    const row = byDate.get(d);
    const score = row
      ? (row.mood ?? 0) + (row.energy ?? 0) + (row.focus ?? 0)
      : null;
    heatmap.push({ date: d, score });
  }
  const sums = { mood: 0, energy: 0, focus: 0, n: 0 };
  for (const r of rows) {
    if (r.mood != null && r.energy != null && r.focus != null) {
      sums.mood += r.mood;
      sums.energy += r.energy;
      sums.focus += r.focus;
      sums.n++;
    }
  }
  const averages = sums.n === 0
    ? { mood: null, energy: null, focus: null }
    : {
        mood: round1(sums.mood / sums.n),
        energy: round1(sums.energy / sums.n),
        focus: round1(sums.focus / sums.n),
      };
  return {
    total: rows.length,
    averages,
    heatmap,
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// ---------- Home loader ----------

export interface HomePayload {
  me: { id: number; login: string };
  today: EntryRow | null;
  recent: EntryRow[];
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
      FROM journal.api_clients
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
    INSERT INTO journal.api_clients (client_id, name, hmac_secret, user_id, created_at)
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
      FROM journal.api_clients
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
      DELETE FROM journal.api_clients
      WHERE client_id = ${clientId} AND user_id = ${userId}
      RETURNING client_id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export { entries };

export const _testing = { parsePgArrayLiteral, normaliseTags, entryFromRow, round1 };
