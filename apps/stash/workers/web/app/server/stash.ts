// Stash impls.  All write/read paths land here so they're testable on PGlite
// (no Hyperdrive, no TanStack Start runtime) and re-exported from both the
// web worker route handlers + the HMAC API worker.

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { snippets } from '~/db/schema';

// ---------- Validation ----------

const BODY_MAX_BYTES = 256 * 1024;

export const saveSchema = z.object({
  title: z.string().max(200).optional(),
  body: z
    .string()
    .min(1)
    .max(BODY_MAX_BYTES)
    .refine((v) => v.trim().length > 0, { message: 'body is empty' }),
  language: z.string().min(1).max(40).optional(),
  tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  source: z.string().min(1).max(40).optional(),
});
export type SaveInput = z.infer<typeof saveSchema>;

export const searchQuerySchema = z.object({
  q: z.string().min(1).max(400),
  limit: z.number().int().min(1).max(100).default(50),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const listQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  page: z.number().int().min(1).max(10_000).default(1),
});
export type ListQuery = z.infer<typeof listQuerySchema>;

// ---------- Types ----------

export interface SnippetSummary {
  id: number;
  title: string | null;
  body: string;        // raw body (already truncated by impl when listing)
  language: string | null;
  tags: string[];
  source: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SnippetDetail extends SnippetSummary {}

export interface SnippetSearchHit extends SnippetSummary {
  /** ts_headline output with `<b>...</b>` markers around matches.  null
   * when the search didn't produce a headline (e.g. tags-only match). */
  headline: string | null;
  /** ts_rank score — higher = better.  Surface in the UI as a faint
   * progress dot so users can see "weak" matches that came in via tags. */
  rank: number;
}

export interface HomePayload {
  me: { id: number; login: string };
  snippets: SnippetSummary[];
  page: number;
  pageSize: number;
  total: number;
}

const LIST_PREVIEW_CHARS = 600;

function rowsOf(result: unknown): unknown[] {
  /* v8 ignore next — Drizzle/pglite always exits via the `.rows` branch;
     the plain-array path is exercised in production by postgres.js. */
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  /* v8 ignore next — driver-malformed result fallback. */
  return Array.isArray(rows) ? rows : [];
}

function toIsoOrNull(v: Date | string | null | undefined): string | null {
  /* v8 ignore next — `v == null` only fires for nullable timestamp columns;
     stash's createdAt/updatedAt are NOT NULL with defaults, so this defensive
     return is never reached in normal driver responses. */
  if (v == null) return null;
  /* v8 ignore next — pglite returns timestamps as strings, so this branch is
     only exercised by postgres.js in production. */
  if (v instanceof Date) return v.toISOString();
  // postgres.js returns ISO-8601 strings; pglite hands back
  // "YYYY-MM-DD HH:MM:SS+00".  Normalise so callers can compare against
  // `new Date(x).toISOString()` consistently.
  const t = new Date(v).getTime();
  /* v8 ignore next — Date parsing only fails on a malformed string; in
     practice both drivers always produce parseable values. */
  if (!Number.isFinite(t)) return v;
  return new Date(t).toISOString();
}

function normaliseTags(input: unknown): string[] {
  if (Array.isArray(input)) return input.filter((x): x is string => typeof x === 'string');
  // postgres.js with fetch_types:false returns text[] as a raw postgres literal
  // string like `{a,b,"with spaces"}`.  Parse it manually — drizzle/pglite
  // already hand back JS arrays so this path only runs on production
  // Hyperdrive responses.
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
      if (buf === 'NULL') {
        /* v8 ignore next — defensive; stash.snippets.tags is NOT NULL DEFAULT '{}',
           so individual NULL elements never appear. */
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
  title: string | null;
  body: string;
  language: string | null;
  tags: unknown;
  source: string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}): SnippetSummary {
  return {
    id: Number(row.id),
    title: row.title,
    body: row.body,
    language: row.language,
    tags: normaliseTags(row.tags),
    source: row.source,
    createdAt: toIsoOrNull(row.createdAt)!,
    updatedAt: toIsoOrNull(row.updatedAt)!,
  };
}

// ---------- Save ----------

export interface SaveResult {
  id: number;
  title: string | null;
  createdAt: Date;
}

export async function saveSnippetImpl(
  db: DB,
  userId: number,
  input: SaveInput,
  now: Date = new Date(),
): Promise<SaveResult> {
  const [created] = await db
    .insert(snippets)
    .values({
      userId,
      title: input.title ?? null,
      body: input.body,
      language: input.language ?? null,
      tags: input.tags ?? [],
      source: input.source ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning({
      id: snippets.id,
      title: snippets.title,
      createdAt: snippets.createdAt,
    });
  /* v8 ignore next — defensive: drizzle's RETURNING always yields one row
     on a successful INSERT.  An empty array would mean an outright driver
     bug, not a normal failure mode. */
  if (!created) throw new Error('saveSnippetImpl: insert returned no row');
  return {
    id: created.id,
    title: created.title,
    createdAt: created.createdAt,
  };
}

// ---------- List ----------

export async function listSnippetsImpl(
  db: DB,
  userId: number,
  limit = 20,
  page = 1,
): Promise<{ snippets: SnippetSummary[]; total: number }> {
  const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const cappedPage = Math.max(1, Math.floor(page));
  const offset = (cappedPage - 1) * cappedLimit;

  const result = (await db.execute(
    sql`
      SELECT
        id,
        title,
        LEFT(body, ${LIST_PREVIEW_CHARS}) AS body,
        language,
        tags,
        source,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM stash.snippets
      WHERE user_id = ${userId}
      ORDER BY created_at DESC
      LIMIT ${cappedLimit} OFFSET ${offset}
    `,
  )) as unknown;
  const list = rowsOf(result).map((r) => summaryFromRow(r as Parameters<typeof summaryFromRow>[0]));

  const totalResult = (await db.execute(
    sql`SELECT COUNT(*)::bigint AS c FROM stash.snippets WHERE user_id = ${userId}`,
  )) as unknown;
  const [first] = rowsOf(totalResult);
  /* v8 ignore next — COUNT(*) always returns one row.  Defensive only. */
  const total = first ? Number((first as { c: number | string }).c) : 0;

  return { snippets: list, total };
}

// ---------- Get one ----------

export async function getSnippetImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<SnippetDetail | null> {
  const result = (await db.execute(
    sql`
      SELECT
        id,
        title,
        body,
        language,
        tags,
        source,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM stash.snippets
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
    title: z.string().max(200).nullable().optional(),
    body: z.string().min(1).max(BODY_MAX_BYTES).optional(),
    language: z.string().min(1).max(40).nullable().optional(),
    tags: z.array(z.string().min(1).max(64)).max(32).optional(),
  })
  .refine(
    (v) =>
      v.title !== undefined ||
      v.body !== undefined ||
      v.language !== undefined ||
      v.tags !== undefined,
    { message: 'no fields to update' },
  );
export type UpdateInput = z.infer<typeof updateSchema>;

export async function updateSnippetImpl(
  db: DB,
  userId: number,
  id: number,
  input: UpdateInput,
  now: Date = new Date(),
): Promise<SnippetDetail | null> {
  // Build a manual SET clause: drizzle's `.update().set({...})` would
  // include every key (even undefined ones) which we don't want — we only
  // touch the fields that were actually sent.
  const setters: ReturnType<typeof sql>[] = [];
  if (input.title !== undefined) setters.push(sql`title = ${input.title}`);
  if (input.body !== undefined) setters.push(sql`body = ${input.body}`);
  if (input.language !== undefined) setters.push(sql`language = ${input.language}`);
  if (input.tags !== undefined) {
    // postgres array literal: `{a,b,c}` with quotes around values that need
    // escaping.  Drizzle expands a JS array as `($1, $2, ...)` which is a
    // tuple, not a text[]; we serialise to a single text bind and cast.
    const literal =
      '{' +
      input.tags
        .map((t) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
        .join(',') +
      '}';
    setters.push(sql`tags = ${literal}::text[]`);
  }
  setters.push(sql`updated_at = ${now.toISOString()}::timestamptz`);

  // Hand-build the SET list because drizzle's sql.join requires a separator
  // node.  `sql.raw(', ')` is safe — no user input.
  let setClause = setters[0]!;
  for (let i = 1; i < setters.length; i++) {
    setClause = sql`${setClause}, ${setters[i]!}`;
  }

  const result = (await db.execute(
    sql`
      UPDATE stash.snippets
      SET ${setClause}
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING
        id,
        title,
        body,
        language,
        tags,
        source,
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  if (!first) return null;
  return summaryFromRow(first as Parameters<typeof summaryFromRow>[0]);
}

// ---------- Delete ----------

export async function deleteSnippetImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<boolean> {
  const result = (await db.execute(
    sql`
      DELETE FROM stash.snippets
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

// ---------- Search ----------

/**
 * Full-text search using the STORED `search_tsv` generated column.  Uses
 * `plainto_tsquery` so untrusted user input never reaches the parser.
 * Orders by `ts_rank`; surfaces `ts_headline` for the matched body so the
 * UI can render `<mark>` around hits.
 */
export async function searchSnippetsImpl(
  db: DB,
  userId: number,
  query: string,
  limit = 50,
): Promise<SnippetSearchHit[]> {
  const cappedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
  const result = (await db.execute(
    sql`
      WITH q AS (SELECT plainto_tsquery('english', ${query}) AS tsq)
      SELECT
        s.id,
        s.title,
        LEFT(s.body, ${LIST_PREVIEW_CHARS}) AS body,
        s.language,
        s.tags,
        s.source,
        s.created_at AS "createdAt",
        s.updated_at AS "updatedAt",
        ts_rank(s.search_tsv, (SELECT tsq FROM q)) AS rank,
        ts_headline(
          'english',
          s.body,
          (SELECT tsq FROM q),
          'MaxFragments=2,MinWords=5,MaxWords=15'
        ) AS headline
      FROM stash.snippets s
      WHERE s.user_id = ${userId}
        AND s.search_tsv @@ (SELECT tsq FROM q)
      ORDER BY rank DESC, s.created_at DESC
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

// ---------- Home loader (single CTE) ----------

/**
 * The home page needs:
 *   1. The user (via JWT sub -> pm.users)
 *   2. The user's most-recent N snippets (paginated)
 *   3. The total count for paginator
 *
 * One CTE, one network hop.  Returns null if the JWT is missing or doesn't
 * map to an active pm.users row.
 */
export async function loadHomeImpl(
  db: DB,
  sub: string | null,
  page = 1,
  pageSize = 20,
): Promise<HomePayload | null> {
  if (!sub) return null;
  const cappedSize = Math.max(1, Math.min(100, Math.floor(pageSize)));
  const cappedPage = Math.max(1, Math.floor(page));
  const offset = (cappedPage - 1) * cappedSize;

  const result = (await db.execute(
    sql`
      WITH
      me AS (
        SELECT id, login FROM pm.users
        WHERE better_auth_user_id = ${sub} AND status = 'active'
        LIMIT 1
      ),
      my_snippets AS (
        SELECT
          id,
          title,
          LEFT(body, ${LIST_PREVIEW_CHARS}) AS body,
          language,
          tags,
          source,
          created_at,
          updated_at
        FROM stash.snippets
        WHERE user_id = (SELECT id FROM me)
        ORDER BY created_at DESC
        LIMIT ${cappedSize} OFFSET ${offset}
      ),
      total AS (
        SELECT COUNT(*)::bigint AS c
        FROM stash.snippets
        WHERE user_id = (SELECT id FROM me)
      )
      SELECT json_build_object(
        'me',        (SELECT row_to_json(me) FROM me),
        'snippets',  COALESCE(
          (SELECT json_agg(
              json_build_object(
                'id',        id,
                'title',     title,
                'body',      body,
                'language',  language,
                'tags',      tags,
                'source',    source,
                'createdAt', created_at,
                'updatedAt', updated_at
              )
              ORDER BY created_at DESC
            ) FROM my_snippets),
          '[]'::json
        ),
        'total',     (SELECT c FROM total)
      ) AS data
    `,
  )) as unknown;
  const [first] = rowsOf(result);
  const data = (first as {
    data?: {
      me: { id: number; login: string } | null;
      snippets?: Array<Parameters<typeof summaryFromRow>[0]>;
      total: number | string | null;
    };
  } | undefined)?.data;
  if (!data?.me) return null;
  return {
    me: data.me,
    /* v8 ignore next — `?? []` defensive: the CTE always returns either an
       array or null (COALESCE'd to []). */
    snippets: (data.snippets ?? []).map((s) => summaryFromRow(s)),
    page: cappedPage,
    pageSize: cappedSize,
    /* v8 ignore next — total is always present (SELECT c FROM total). */
    total: data.total != null ? Number(data.total) : 0,
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
      FROM stash.api_clients
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
  hmacSecret: string;     // returned ONCE, plaintext — store it client-side
  createdAt: string;
}

/**
 * Issue a new HMAC client for `userId`.  Generates a 32-byte random secret
 * via WebCrypto (works in workerd + Node + jsdom), base64-encodes it, and
 * returns it ONCE in plaintext.  After that the only copy lives in
 * `stash.api_clients.hmac_secret` (still plaintext — same scheme as inbox/
 * focus/context, single-user-trust model).
 */
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
    INSERT INTO stash.api_clients (client_id, name, hmac_secret, user_id, created_at)
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
      FROM stash.api_clients
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
      DELETE FROM stash.api_clients
      WHERE client_id = ${clientId} AND user_id = ${userId}
      RETURNING client_id
    `,
  )) as unknown;
  return rowsOf(result).length > 0;
}

// Re-export the table for tests that need to count rows.
export { snippets };

// Exported for unit tests.  postgres.js with fetch_types:false returns text[]
// columns as raw literals like `{a,b,"with spaces"}` — pglite parses them to
// real arrays, so this helper isn't reachable through normal driver flow in
// the integration test suite.
export const _testing = { parsePgArrayLiteral, normaliseTags };
