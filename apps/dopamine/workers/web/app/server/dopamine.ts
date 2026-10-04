// Dopamine impls.  Testable on PGlite (no Hyperdrive, no TanStack Start runtime).

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';

const TEXT_MAX = 4_000;

export const KINDS = [
  'pr_merged',
  'issue_closed',
  'focus_completed',
  'inbox_zeroed',
  'custom',
] as const;
export type Kind = (typeof KINDS)[number];

export const eventSchema = z.object({
  kind: z.enum(KINDS),
  title: z.string().min(1).max(280),
  source_ref: z.string().max(280).optional().nullable(),
  body: z.string().max(TEXT_MAX).optional().nullable(),
  importance: z.number().int().min(1).max(3).optional(),
  tags: z.array(z.string().min(1).max(64)).max(16).optional(),
});
export type EventInput = z.infer<typeof eventSchema>;

export interface EventRow {
  id: number;
  userId: number;
  kind: string;
  title: string;
  body: string | null;
  sourceRef: string | null;
  importance: number;
  tags: string[];
  occurredAt: string;
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
      /* v8 ignore next 3 — tags is NOT NULL DEFAULT '{}'. */
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

function tagsToLiteral(tags: string[]): string {
  return (
    '{' +
    tags
      .map((t) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
      .join(',') +
    '}'
  );
}

function rowToEvent(row: Record<string, unknown>): EventRow {
  return {
    id: Number(row.id),
    /* v8 ignore next — every caller aliases user_id AS "userId"; snake-case is defensive. */
    userId: Number(row.userId ?? row.user_id),
    kind: String(row.kind),
    title: String(row.title),
    body: (row.body as string | null) ?? null,
    sourceRef: (row.sourceRef as string | null) ?? null,
    importance: Number(row.importance ?? 1),
    tags: normaliseTags(row.tags),
    occurredAt: toIso(row.occurredAt as Date | string),
  };
}

// ---------- Insert ----------

export async function createEventImpl(
  db: DB,
  userId: number,
  input: EventInput,
  now: Date = new Date(),
): Promise<EventRow> {
  const tags = input.tags ?? [];
  const tagsLiteral = tagsToLiteral(tags);
  const result = (await db.execute(
    sql`
      INSERT INTO dopamine.events
        (user_id, kind, title, body, source_ref, importance, tags, occurred_at)
      VALUES
        (${userId}, ${input.kind}, ${input.title},
         ${input.body ?? null}, ${input.source_ref ?? null},
         ${input.importance ?? 1},
         ${tagsLiteral}::text[],
         ${now.toISOString()}::timestamptz)
      RETURNING
        id,
        user_id AS "userId",
        kind, title, body,
        source_ref AS "sourceRef",
        importance, tags,
        occurred_at AS "occurredAt"
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  /* v8 ignore next — RETURNING always yields one row. */
  if (!first) throw new Error('createEventImpl: returning produced no row');
  return rowToEvent(first as Record<string, unknown>);
}

// ---------- Reads ----------

export async function listRecentImpl(
  db: DB,
  userId: number,
  limit = 50,
): Promise<EventRow[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
  const result = (await db.execute(
    sql`
      SELECT
        id, user_id AS "userId", kind, title, body,
        source_ref AS "sourceRef", importance, tags,
        occurred_at AS "occurredAt"
      FROM dopamine.events
      WHERE user_id = ${userId}
      ORDER BY occurred_at DESC
      LIMIT ${safeLimit}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => rowToEvent(r as Record<string, unknown>));
}

export async function listPagedImpl(
  db: DB,
  userId: number,
  limit = 50,
  offset = 0,
): Promise<EventRow[]> {
  const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 500);
  const safeOffset = Math.max(0, Math.floor(offset));
  const result = (await db.execute(
    sql`
      SELECT
        id, user_id AS "userId", kind, title, body,
        source_ref AS "sourceRef", importance, tags,
        occurred_at AS "occurredAt"
      FROM dopamine.events
      WHERE user_id = ${userId}
      ORDER BY occurred_at DESC
      LIMIT ${safeLimit}
      OFFSET ${safeOffset}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => rowToEvent(r as Record<string, unknown>));
}

export async function getRandomWinImpl(
  db: DB,
  userId: number,
  sinceDays = 90,
  now: Date = new Date(),
): Promise<EventRow | null> {
  const safeDays = Math.max(1, Math.floor(sinceDays));
  const cutoff = new Date(now.getTime() - safeDays * 24 * 60 * 60 * 1000).toISOString();
  const result = (await db.execute(
    sql`
      SELECT
        id, user_id AS "userId", kind, title, body,
        source_ref AS "sourceRef", importance, tags,
        occurred_at AS "occurredAt"
      FROM dopamine.events
      WHERE user_id = ${userId}
        AND occurred_at >= ${cutoff}::timestamptz
      ORDER BY random()
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  return rowToEvent(first as Record<string, unknown>);
}

// ---------- Home loader ----------

export interface HomePayload {
  me: { id: number; login: string };
  recent: EventRow[];
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
  const recent = await listRecentImpl(db, Number(me.id), 50);
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
      FROM dopamine.api_clients
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
    INSERT INTO dopamine.api_clients (client_id, name, hmac_secret, user_id, created_at)
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
      FROM dopamine.api_clients
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
      DELETE FROM dopamine.api_clients
      WHERE client_id = ${clientId} AND user_id = ${userId}
      RETURNING client_id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export const _testing = { parsePgArrayLiteral, normaliseTags, tagsToLiteral, rowToEvent, toIso };
