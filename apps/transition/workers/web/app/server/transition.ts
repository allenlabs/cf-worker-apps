// Transition impls.  Testable on PGlite (no Hyperdrive, no TanStack Start runtime).

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';

const TEXT_MAX = 4_000;

export const TARGETS = ['context', 'inbox', 'journal'] as const;
export type Target = typeof TARGETS[number];

export const saveRitualSchema = z.object({
  leaving_at: z.string().min(1).max(TEXT_MAX),
  next_step: z.string().min(1).max(TEXT_MAX),
  might_forget: z.string().max(TEXT_MAX).optional().nullable(),
  target: z.enum(TARGETS).optional().nullable(),
});
export type SaveRitualInput = z.infer<typeof saveRitualSchema>;

export interface RitualRow {
  id: number;
  userId: number;
  leavingAt: string;
  nextStep: string;
  mightForget: string | null;
  target: string | null;
  createdAt: string;
}

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — pglite returns `{rows:[]}`; postgres.js returns plain array. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

function toIso(v: Date | string | null | undefined): string {
  /* v8 ignore next — defensive: timestamps are NOT NULL. */
  if (v == null) return '';
  /* v8 ignore next — pglite returns strings; Date branch fires in production. */
  if (v instanceof Date) return v.toISOString();
  const t = new Date(v).getTime();
  /* v8 ignore next — parseable timestamps in both drivers. */
  if (!Number.isFinite(t)) return String(v);
  return new Date(t).toISOString();
}

function rowToRitual(row: Record<string, unknown>): RitualRow {
  return {
    id: Number(row.id),
    /* v8 ignore next — every caller aliases user_id AS "userId"; snake-case is defensive. */
    userId: Number(row.userId ?? row.user_id),
    leavingAt: String(row.leavingAt ?? ''),
    nextStep: String(row.nextStep ?? ''),
    mightForget: (row.mightForget as string | null) ?? null,
    target: (row.target as string | null) ?? null,
    createdAt: toIso(row.createdAt as Date | string),
  };
}

// ---------- Save ----------

export async function saveRitualImpl(
  db: DB,
  userId: number,
  input: SaveRitualInput,
  now: Date = new Date(),
): Promise<RitualRow> {
  // TODO: fan out to the chosen target (context/inbox/journal) via their
  // HMAC APIs.  v1 just stores — the parent task explicitly says do not
  // implement the cross-app calls yet.
  const result = (await db.execute(
    sql`
      INSERT INTO transition.rituals
        (user_id, leaving_at, next_step, might_forget, target, created_at)
      VALUES
        (${userId}, ${input.leaving_at}, ${input.next_step},
         ${input.might_forget ?? null}, ${input.target ?? null},
         ${now.toISOString()}::timestamptz)
      RETURNING
        id,
        user_id AS "userId",
        leaving_at AS "leavingAt",
        next_step AS "nextStep",
        might_forget AS "mightForget",
        target,
        created_at AS "createdAt"
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  /* v8 ignore next — RETURNING always yields one row. */
  if (!first) throw new Error('saveRitualImpl: returning produced no row');
  return rowToRitual(first as Record<string, unknown>);
}

// ---------- Reads ----------

export async function listRecentImpl(
  db: DB,
  userId: number,
  limit = 20,
): Promise<RitualRow[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
  const result = (await db.execute(
    sql`
      SELECT
        id, user_id AS "userId",
        leaving_at AS "leavingAt",
        next_step AS "nextStep",
        might_forget AS "mightForget",
        target,
        created_at AS "createdAt"
      FROM transition.rituals
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${safeLimit}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => rowToRitual(r as Record<string, unknown>));
}

// ---------- Home loader ----------

export interface HomePayload {
  me: { id: number; login: string };
  recent: RitualRow[];
}

export async function loadHomeImpl(
  db: DB,
  sub: string | null,
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
  const recent = await listRecentImpl(db, Number(me.id), 20);
  return {
    me: { id: Number(me.id), login: me.login },
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
      FROM transition.api_clients
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
    INSERT INTO transition.api_clients (client_id, name, hmac_secret, user_id, created_at)
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
      FROM transition.api_clients
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
    `,
  )) as unknown;
  return rowsOf(result).map((r) => {
    const row = r as { clientId: string; name: string; createdAt: Date | string };
    return {
      clientId: row.clientId,
      name: row.name,
      createdAt: toIso(row.createdAt),
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
      DELETE FROM transition.api_clients
      WHERE client_id = ${clientId} AND user_id = ${userId}
      RETURNING client_id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export const _testing = { rowToRitual, toIso };
