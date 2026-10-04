// Intent impls.  Testable on PGlite (no Hyperdrive, no TanStack Start runtime).

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';

const TEXT_MAX = 280;

export const setIntentSchema = z.object({
  text: z.string().max(TEXT_MAX),
});
export type SetIntentInput = z.infer<typeof setIntentSchema>;

export interface CurrentIntent {
  text: string;
  updatedAt: string;
}

export interface HistoryEntry {
  id: number;
  text: string;
  setAt: string;
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

// ---------- Set / get current ----------

export async function setIntentImpl(
  db: DB,
  userId: number,
  input: SetIntentInput,
  now: Date = new Date(),
): Promise<CurrentIntent> {
  const text = input.text;
  const upsert = (await db.execute(
    sql`
      INSERT INTO intent.current (user_id, text, updated_at)
      VALUES (${userId}, ${text}, ${now.toISOString()}::timestamptz)
      ON CONFLICT (user_id) DO UPDATE
        SET text = EXCLUDED.text,
            updated_at = EXCLUDED.updated_at
      RETURNING text, updated_at AS "updatedAt"
    `,
  )) as unknown;
  const [row] = rowsOf(upsert);
  /* v8 ignore next — RETURNING always yields one row on successful upsert. */
  if (!row) throw new Error('setIntentImpl: upsert returned no row');
  const r = row as { text: string; updatedAt: Date | string };
  await db.execute(sql`
    INSERT INTO intent.history (user_id, text, set_at)
    VALUES (${userId}, ${text}, ${now.toISOString()}::timestamptz)
  `);
  return { text: r.text, updatedAt: toIso(r.updatedAt) };
}

export async function getCurrentIntentImpl(
  db: DB,
  userId: number,
): Promise<CurrentIntent> {
  const result = (await db.execute(
    sql`
      SELECT text, updated_at AS "updatedAt"
      FROM intent.current
      WHERE user_id = ${userId}
      LIMIT 1
    `,
  )) as unknown;
  const [row] = rowsOf(result);
  if (!row) return { text: '', updatedAt: '' };
  const r = row as { text: string; updatedAt: Date | string };
  return { text: r.text, updatedAt: toIso(r.updatedAt) };
}

export async function listHistoryImpl(
  db: DB,
  userId: number,
  limit = 50,
): Promise<HistoryEntry[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
  const result = (await db.execute(
    sql`
      SELECT id, text, set_at AS "setAt"
      FROM intent.history
      WHERE user_id = ${userId}
      ORDER BY set_at DESC
      LIMIT ${safeLimit}
    `,
  )) as unknown;
  return rowsOf(result).map((row) => {
    const r = row as { id: number | string; text: string; setAt: Date | string };
    return { id: Number(r.id), text: r.text, setAt: toIso(r.setAt) };
  });
}

// ---------- Home loader ----------

export interface HomePayload {
  me: { id: number; login: string };
  current: CurrentIntent;
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
  const current = await getCurrentIntentImpl(db, Number(me.id));
  return {
    me: { id: Number(me.id), login: me.login },
    current,
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
      FROM intent.api_clients
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
    INSERT INTO intent.api_clients (client_id, name, hmac_secret, user_id, created_at)
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
      FROM intent.api_clients
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
      DELETE FROM intent.api_clients
      WHERE client_id = ${clientId} AND user_id = ${userId}
      RETURNING client_id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export const _testing = { toIso };
