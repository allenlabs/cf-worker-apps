// Solved impls.  Testable on PGlite (no Hyperdrive, no TanStack Start runtime).
// Re-exported from both the web worker route handlers + the HMAC API worker.

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { entries } from '~/db/schema';

// ---------- Validation ----------

const BODY_MAX_BYTES = 256 * 1024;
const TITLE_MAX = 240;

export const saveSchema = z.object({
  title: z.string().min(1).max(TITLE_MAX),
  body: z
    .string()
    .min(1)
    .max(BODY_MAX_BYTES)
    .refine((v) => v.trim().length > 0, { message: 'body is empty' }),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  source: z.string().min(1).max(40).optional(),
  sourceRef: z.string().min(1).max(240).optional(),
  sourceUrl: z.string().url().max(2048).optional(),
});
export type SaveInput = z.infer<typeof saveSchema>;

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(400),
  limit: z.number().int().min(1).max(100).default(50),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

// ---------- Types ----------

export interface EntrySummary {
  id: number;
  title: string;
  body: string;
  tags: string[];
  source: string | null;
  sourceRef: string | null;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EntrySearchHit extends EntrySummary {
  headline: string | null;
  rank: number;
}

export interface HomePayload {
  me: { id: number; login: string };
  entries: EntrySummary[];
}

const LIST_PREVIEW_CHARS = 600;
const HOME_LIMIT = 50;

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
  /* v8 ignore next — pglite returns strings; Date branch fires in production. */
  if (v instanceof Date) return v.toISOString();
  const t = new Date(v).getTime();
  /* v8 ignore next — parseable timestamps in both drivers. */
  if (!Number.isFinite(t)) return v;
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
      /* v8 ignore next 3 — solved.entries.tags is NOT NULL DEFAULT '{}'. */
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

function summaryFromRow(row: {
  id: number | string;
  title: string;
  body: string;
  tags: unknown;
  source: string | null;
  sourceRef: string | null;
  sourceUrl: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): EntrySummary {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    tags: normaliseTags(row.tags),
    source: row.source,
    sourceRef: row.sourceRef,
    sourceUrl: row.sourceUrl,
    createdAt: toIsoOrNull(row.createdAt)!,
    updatedAt: toIsoOrNull(row.updatedAt)!,
  };
}

// ---------- Save ----------

export interface SaveResult {
  id: number;
  title: string;
  createdAt: Date;
}

export async function saveEntryImpl(
  db: DB,
  userId: number,
  input: SaveInput,
  now: Date = new Date(),
): Promise<SaveResult> {
  const [created] = await db
    .insert(entries)
    .values({
      userId,
      title: input.title,
      body: input.body,
      tags: input.tags ?? [],
      source: input.source ?? null,
      sourceRef: input.sourceRef ?? null,
      sourceUrl: input.sourceUrl ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: entries.id,
      title: entries.title,
      createdAt: entries.createdAt,
    });
  /* v8 ignore next — drizzle's RETURNING always yields one row on a successful INSERT. */
  if (!created) throw new Error('saveEntryImpl: insert returned no row');
  return {
    id: created.id,
    title: created.title,
    createdAt: created.createdAt,
  };
}

// ---------- Get one ----------

export async function getEntryImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<EntrySummary | null> {
  const result = (await db.execute(
    sql`
      SELECT
        id,
        title,
        body,
        tags,
        source,
        source_ref AS "sourceRef",
        source_url AS "sourceUrl",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM solved.entries
      WHERE id = ${id} AND user_id = ${userId}
      LIMIT 1
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  return summaryFromRow(first as Parameters<typeof summaryFromRow>[0]);
}

// ---------- Update ----------

export const updateSchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX).optional(),
    body: z.string().min(1).max(BODY_MAX_BYTES).optional(),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .refine(
    (v) => v.title !== undefined || v.body !== undefined || v.tags !== undefined,
    { message: 'no fields to update' },
  );
export type UpdateInput = z.infer<typeof updateSchema>;

export async function updateEntryImpl(
  db: DB,
  userId: number,
  id: number,
  input: UpdateInput,
  now: Date = new Date(),
): Promise<EntrySummary | null> {
  const setters: ReturnType<typeof sql>[] = [];
  if (input.title !== undefined) setters.push(sql`title = ${input.title}`);
  if (input.body !== undefined) setters.push(sql`body = ${input.body}`);
  if (input.tags !== undefined) {
    const literal =
      '{' +
      input.tags
        .map((t) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        .join(',') +
      '}';
    setters.push(sql`tags = ${literal}::text[]`);
  }
  setters.push(sql`updated_at = ${now.toISOString()}::timestamptz`);

  let setClause = setters[0]!;
  for (let i = 1; i < setters.length; i++) {
    setClause = sql`${setClause}, ${setters[i]!}`;
  }

  const result = (await db.execute(
    sql`
      UPDATE solved.entries
      SET ${setClause}
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING
        id,
        title,
        body,
        tags,
        source,
        source_ref AS "sourceRef",
        source_url AS "sourceUrl",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  return summaryFromRow(first as Parameters<typeof summaryFromRow>[0]);
}

// ---------- Delete ----------

export async function deleteEntryImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      DELETE FROM solved.entries
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

// ---------- Search ----------

export async function searchEntriesImpl(
  db: DB,
  userId: number,
  query: string,
  limit = 50,
): Promise<EntrySearchHit[]> {
  const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = (await db.execute(
    sql`
      WITH q AS (SELECT plainto_tsquery('english', ${query}) AS tsq)
      SELECT
        e.id,
        e.title,
        LEFT(e.body, ${LIST_PREVIEW_CHARS}) AS body,
        e.tags,
        e.source,
        e.source_ref AS "sourceRef",
        e.source_url AS "sourceUrl",
        e.created_at AS "createdAt",
        e.updated_at AS "updatedAt",
        ts_rank(e.search_tsv, (SELECT tsq FROM q)) AS rank,
        ts_headline(
          'english',
          e.body,
          (SELECT tsq FROM q),
          'MaxFragments=2,MinWords=5,MaxWords=15'
        ) AS headline
      FROM solved.entries e
      WHERE e.user_id = ${userId}
        AND e.search_tsv @@ (SELECT tsq FROM q)
      ORDER BY rank DESC, e.created_at DESC
      LIMIT ${cappedLimit}
    `,
  )) as unknown;
  return rowsOf(result).map((r) => {
    const row = r as Parameters<typeof summaryFromRow>[0] & {
      rank: number | string;
      headline: string | null;
    };
    const summary = summaryFromRow(row);
    return {
      ...summary,
      rank: Number(row.rank),
      headline: row.headline,
    };
  });
}

// ---------- Home loader (recent 50) ----------

export async function loadHomeImpl(
  db: DB,
  sub: string | null,
): Promise<HomePayload | null> {
  if (!sub) return null;
  const result = (await db.execute(
    sql`
      WITH
      me AS (
        SELECT id, login FROM pm.users
        WHERE better_auth_user_id = ${sub} AND status = 'active'
        LIMIT 1
      ),
      my_entries AS (
        SELECT
          id,
          title,
          LEFT(body, ${LIST_PREVIEW_CHARS}) AS body,
          tags,
          source,
          source_ref,
          source_url,
          created_at,
          updated_at
        FROM solved.entries
        WHERE user_id = (SELECT id FROM me)
        ORDER BY created_at DESC
        LIMIT ${HOME_LIMIT}
      )
      SELECT json_build_object(
        'me',      (SELECT row_to_json(me) FROM me),
        'entries', COALESCE(
          (SELECT json_agg(
              json_build_object(
                'id',        id,
                'title',     title,
                'body',      body,
                'tags',      tags,
                'source',    source,
                'sourceRef', source_ref,
                'sourceUrl', source_url,
                'createdAt', created_at,
                'updatedAt', updated_at
              )
              ORDER BY created_at DESC
            ) FROM my_entries),
          '[]'::json
        )
      ) AS data
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  const data = (first as {
    data?: {
      me: { id: number; login: string } | null;
      entries?: Array<Parameters<typeof summaryFromRow>[0]>;
    };
  } | undefined)?.data;
  if (!data?.me) return null;
  return {
    me: data.me,
    /* v8 ignore next — `?? []` defensive: CTE always returns array or COALESCE'd []. */
    entries: (data.entries ?? []).map((e) => summaryFromRow(e)),
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
      FROM solved.api_clients
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
    INSERT INTO solved.api_clients (client_id, name, hmac_secret, user_id, created_at)
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
      FROM solved.api_clients
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
      DELETE FROM solved.api_clients
      WHERE client_id = ${clientId} AND user_id = ${userId}
      RETURNING client_id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

export { entries };

export const _testing = { parsePgArrayLiteral, normaliseTags };
