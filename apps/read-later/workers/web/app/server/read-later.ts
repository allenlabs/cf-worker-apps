// Read-later impls.  All write paths land here so they're testable on PGlite
// (no Hyperdrive, no TanStack Start runtime) and re-exported from both the
// web worker route handlers + the HMAC API worker.

import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { items } from '~/db/schema';
import { extractFromUrl, type ExtractDeps, EMPTY_EXTRACTION } from '~/lib/reader';

// ---------- Validation ----------

const TAG_MAX = 32;

export const saveSchema = z.object({
  url: z.string().url().max(2048),
  title: z.string().min(1).max(512).optional(),
  tags: z.array(z.string().min(1).max(64)).max(TAG_MAX).optional(),
  source: z.enum(['web', 'cli', 'api', 'inbox']).optional(),
});
export type SaveInput = z.infer<typeof saveSchema>;

export const idSchema = z.object({
  id: z.number().int().positive(),
});
export type IdInput = z.infer<typeof idSchema>;

// ---------- Types ----------

export interface ItemSummary {
  id: number;
  url: string;
  hostname: string;
  title: string | null;
  excerpt: string | null;
  estimatedMinutes: number | null;
  tags: string[];
  savedAt: string;
  readAt: string | null;
  skippedCount: number;
  source: string | null;
}

export interface ItemDetail extends ItemSummary {
  contentHtml: string | null;
  wordCount: number | null;
}

export interface QueuePayload {
  me: { id: number; login: string };
  next: ItemSummary | null;
  unreadCount: number;
}

export interface ListPayload {
  items: ItemSummary[];
  total: number;
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
  /* v8 ignore next — pglite hands back strings from RETURNING, so the
     `instanceof Date` branch fires only in production (postgres.js +
     timestamp typecast paths). */
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

function hostnameOfSafe(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* v8 ignore next 2 — every URL stored has been validated by the Zod
       schema, so the URL constructor cannot fail. */
    return '';
  }
}

// ---------- Save ----------

export interface SaveResult {
  id: number;
  url: string;
  title: string | null;
  estimatedMinutes: number | null;
  savedAt: Date;
}

/**
 * Save a URL.  If `deps.fetch` is provided we'll do reader-mode extraction
 * inline; otherwise we skip extraction and store the bare URL.  The CLI /
 * HMAC API caller passes deps; tests pin a stubbed fetch.
 *
 * The function is total — extraction failures fall through to a bare-URL
 * save so the user never loses a capture.
 */
export async function saveItemImpl(
  db: DB,
  userId: number,
  input: SaveInput,
  now: Date = new Date(),
  deps?: ExtractDeps,
): Promise<SaveResult> {
  const extracted = deps
    ? await extractFromUrl(input.url, deps)
    : EMPTY_EXTRACTION;
  // User-supplied title overrides the extracted one.
  const finalTitle = input.title ?? extracted.title ?? null;
  const tags = input.tags ?? [];
  const [created] = await db
    .insert(items)
    .values({
      userId,
      url: input.url,
      title: finalTitle,
      excerpt: extracted.excerpt,
      contentHtml: extracted.contentHtml,
      wordCount: extracted.wordCount,
      estimatedMinutes: extracted.estimatedMinutes,
      tags,
      source: input.source ?? null,
      savedAt: now,
    })
    .returning({
      id: items.id,
      url: items.url,
      title: items.title,
      estimatedMinutes: items.estimatedMinutes,
      savedAt: items.savedAt,
    });
  /* v8 ignore next — defensive: drizzle's RETURNING always yields one row
     on a successful INSERT.  An empty array would mean an outright driver
     bug, not a normal failure mode. */
  if (!created) throw new Error('saveItemImpl: insert returned no row');
  return {
    id: created.id,
    url: created.url,
    title: created.title,
    estimatedMinutes: created.estimatedMinutes,
    savedAt: created.savedAt,
  };
}

// ---------- Next ----------

/**
 * Return the next item to surface.  Priority:
 *   1. estimated_minutes <= freeMinutes (when freeMinutes is provided),
 *      then oldest savedAt.
 *   2. Otherwise: oldest unread.
 *
 * Always `read_at IS NULL`.  Returns null when there's nothing unread.
 */
export async function nextItemImpl(
  db: DB,
  userId: number,
  freeMinutes?: number | null,
): Promise<ItemSummary | null> {
  // Use raw SQL to express the conditional priority cleanly.  Skipped items
  // sink to the bottom: ORDER BY skipped_count, savedAt.
  let result: unknown;
  if (typeof freeMinutes === 'number' && Number.isFinite(freeMinutes) && freeMinutes > 0) {
    result = await db.execute(sql`
      SELECT
        id, url, title, excerpt,
        estimated_minutes AS "estimatedMinutes",
        tags,
        saved_at  AS "savedAt",
        read_at   AS "readAt",
        skipped_count AS "skippedCount",
        source
      FROM read_later.items
      WHERE user_id = ${userId} AND read_at IS NULL
      ORDER BY
        (estimated_minutes IS NOT NULL AND estimated_minutes <= ${freeMinutes}) DESC,
        skipped_count ASC,
        saved_at ASC
      LIMIT 1
    `);
  } else {
    result = await db.execute(sql`
      SELECT
        id, url, title, excerpt,
        estimated_minutes AS "estimatedMinutes",
        tags,
        saved_at  AS "savedAt",
        read_at   AS "readAt",
        skipped_count AS "skippedCount",
        source
      FROM read_later.items
      WHERE user_id = ${userId} AND read_at IS NULL
      ORDER BY skipped_count ASC, saved_at ASC
      LIMIT 1
    `);
  }
  const [first] = rowsOf(result);
  if (!first) return null;
  return toItemSummary(first);
}

function toItemSummary(raw: unknown): ItemSummary {
  const row = raw as {
    id: number;
    url: string;
    title: string | null;
    excerpt: string | null;
    estimatedMinutes: number | string | null;
    tags: string[] | null;
    savedAt: Date | string;
    readAt: Date | string | null;
    skippedCount: number | string;
    source: string | null;
  };
  return {
    id: Number(row.id),
    url: row.url,
    hostname: hostnameOfSafe(row.url),
    title: row.title,
    excerpt: row.excerpt,
    estimatedMinutes:
      row.estimatedMinutes != null ? Number(row.estimatedMinutes) : null,
    /* v8 ignore next — tags column is NOT NULL with default {}; the ?? is
       defensive for a hypothetical driver bug. */
    tags: Array.isArray(row.tags) ? row.tags : [],
    savedAt: toIsoOrNull(row.savedAt)!,
    readAt: toIsoOrNull(row.readAt),
    /* v8 ignore next — skipped_count NOT NULL default 0; defensive only. */
    skippedCount: Number(row.skippedCount ?? 0),
    source: row.source,
  };
}

function toItemDetail(raw: unknown): ItemDetail {
  const row = raw as {
    contentHtml: string | null;
    wordCount: number | string | null;
  };
  return {
    ...toItemSummary(raw),
    contentHtml: row.contentHtml,
    wordCount: row.wordCount != null ? Number(row.wordCount) : null,
  };
}

// ---------- List ----------

export async function listItemsImpl(
  db: DB,
  userId: number,
  opts: {
    limit?: number;
    includeRead?: boolean;
    tag?: string;
  } = {},
): Promise<ListPayload> {
  const capped = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 50)));
  const includeRead = opts.includeRead === true;
  const tag = opts.tag && opts.tag.length > 0 ? opts.tag : null;

  // Build the WHERE clauses inline.  We can't use drizzle's `and()` because
  // the rest of the query is raw SQL — keep it consistent.
  const result = await db.execute(sql`
    SELECT
      id, url, title, excerpt,
      estimated_minutes AS "estimatedMinutes",
      tags,
      saved_at AS "savedAt",
      read_at  AS "readAt",
      skipped_count AS "skippedCount",
      source,
      COUNT(*) OVER () AS "_total"
    FROM read_later.items
    WHERE user_id = ${userId}
      AND (${includeRead}::boolean OR read_at IS NULL)
      AND (${tag}::text IS NULL OR ${tag}::text = ANY(tags))
    ORDER BY read_at NULLS FIRST, saved_at DESC
    LIMIT ${capped}
  `);
  const rows = rowsOf(result);
  if (rows.length === 0) return { items: [], total: 0 };
  const summaries = rows.map(toItemSummary);
  /* v8 ignore next 3 — COUNT(*) OVER () always returns a number; the
     `?? rows.length` fallback is defensive only. */
  const total = Number(
    (rows[0] as { _total: number | string })._total ?? rows.length,
  );
  return { items: summaries, total };
}

// ---------- Get one ----------

export async function getItemImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<ItemDetail | null> {
  const result = await db.execute(sql`
    SELECT
      id, url, title, excerpt,
      content_html AS "contentHtml",
      word_count   AS "wordCount",
      estimated_minutes AS "estimatedMinutes",
      tags,
      saved_at AS "savedAt",
      read_at  AS "readAt",
      skipped_count AS "skippedCount",
      source
    FROM read_later.items
    WHERE id = ${id} AND user_id = ${userId}
    LIMIT 1
  `);
  const [first] = rowsOf(result);
  if (!first) return null;
  return toItemDetail(first);
}

// ---------- Mark done ----------

export async function markDoneImpl(
  db: DB,
  userId: number,
  id: number,
  now: Date = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  const result = await db.execute(sql`
    UPDATE read_later.items
    SET read_at = ${nowIso}::timestamptz
    WHERE id = ${id} AND user_id = ${userId} AND read_at IS NULL
    RETURNING id
  `);
  return rowsOf(result).length > 0;
}

// ---------- Skip ----------

/**
 * Bump skipped_count.  The item stays unread but gets sunk in the priority
 * ordering (see nextItemImpl) so the user sees a different thing next time.
 */
export async function skipItemImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE read_later.items
    SET skipped_count = skipped_count + 1
    WHERE id = ${id} AND user_id = ${userId} AND read_at IS NULL
    RETURNING id
  `);
  return rowsOf(result).length > 0;
}

// ---------- Delete ----------

export async function deleteItemImpl(
  db: DB,
  userId: number,
  id: number,
): Promise<boolean> {
  const result = await db.execute(sql`
    DELETE FROM read_later.items
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id
  `);
  return rowsOf(result).length > 0;
}

// ---------- Queue surface (single CTE) ----------

/**
 * Home page payload: the user, the ONE NEXT thing to read, and the total
 * unread count.  One Hetzner round-trip.
 */
export async function loadQueueImpl(
  db: DB,
  sub: string | null,
  freeMinutes?: number | null,
): Promise<QueuePayload | null> {
  if (!sub) return null;
  const result = await db.execute(sql`
    WITH
    me AS (
      SELECT id, login FROM pm.users
      WHERE better_auth_user_id = ${sub} AND status = 'active'
      LIMIT 1
    ),
    next AS (
      SELECT
        id, url, title, excerpt,
        estimated_minutes,
        tags,
        saved_at, read_at, skipped_count, source
      FROM read_later.items
      WHERE user_id = (SELECT id FROM me) AND read_at IS NULL
      ORDER BY
        (
          ${freeMinutes ?? null}::int IS NOT NULL
          AND estimated_minutes IS NOT NULL
          AND estimated_minutes <= ${freeMinutes ?? null}::int
        ) DESC,
        skipped_count ASC,
        saved_at ASC
      LIMIT 1
    ),
    unread AS (
      SELECT COUNT(*)::int AS c FROM read_later.items
      WHERE user_id = (SELECT id FROM me) AND read_at IS NULL
    )
    SELECT json_build_object(
      'me',          (SELECT row_to_json(me) FROM me),
      'next',        (SELECT row_to_json(next) FROM next),
      'unreadCount', (SELECT c FROM unread)
    ) AS data
  `);
  const [first] = rowsOf(result);
  const data = (first as { data?: {
    me: { id: number; login: string } | null;
    next: {
      id: number;
      url: string;
      title: string | null;
      excerpt: string | null;
      estimated_minutes: number | null;
      tags: string[] | null;
      saved_at: string;
      read_at: string | null;
      skipped_count: number;
      source: string | null;
    } | null;
    unreadCount: number;
  } } | undefined)?.data;
  if (!data?.me) return null;
  const next = data.next
    ? toItemSummary({
        id: data.next.id,
        url: data.next.url,
        title: data.next.title,
        excerpt: data.next.excerpt,
        estimatedMinutes: data.next.estimated_minutes,
        tags: data.next.tags,
        savedAt: data.next.saved_at,
        readAt: data.next.read_at,
        skippedCount: data.next.skipped_count,
        source: data.next.source,
      })
    : null;
  return {
    me: data.me,
    next,
    /* v8 ignore next — unread COUNT(*)::int is never NULL; defensive only. */
    unreadCount: Number(data.unreadCount ?? 0),
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
      FROM read_later.api_clients
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

// ---------- API client admin (web UI only, cookie-auth) ----------

export interface IssuedApiClient {
  id: number;
  clientId: string;
  name: string;
  hmacSecret: string;
  createdAt: string;
}

export const issueApiClientSchema = z.object({
  clientId: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i),
  name: z.string().min(1).max(200),
});

/**
 * Issue a new HMAC client.  The secret is returned exactly once; the caller
 * is responsible for surfacing it to the user.
 */
export async function issueApiClientImpl(
  db: DB,
  userId: number,
  input: z.infer<typeof issueApiClientSchema>,
  secret: string,
  now: Date = new Date(),
): Promise<IssuedApiClient> {
  const result = await db.execute(sql`
    INSERT INTO read_later.api_clients (client_id, name, hmac_secret, user_id, created_at)
    VALUES (${input.clientId}, ${input.name}, ${secret}, ${userId}, ${now.toISOString()}::timestamptz)
    RETURNING id, client_id AS "clientId", name, created_at AS "createdAt"
  `);
  const [first] = rowsOf(result);
  /* v8 ignore next — drizzle's RETURNING always yields one row on
     successful INSERT.  An empty array means a driver bug. */
  if (!first) throw new Error('issueApiClientImpl: insert returned no row');
  const row = first as { id: number; clientId: string; name: string; createdAt: Date | string };
  return {
    id: Number(row.id),
    clientId: row.clientId,
    name: row.name,
    hmacSecret: secret,
    createdAt: toIsoOrNull(row.createdAt)!,
  };
}

export async function listApiClientsImpl(
  db: DB,
  userId: number,
): Promise<Array<{ id: number; clientId: string; name: string; createdAt: string }>> {
  const result = await db.execute(sql`
    SELECT id, client_id AS "clientId", name, created_at AS "createdAt"
    FROM read_later.api_clients
    WHERE user_id = ${userId}
    ORDER BY created_at DESC
  `);
  return rowsOf(result).map((r) => {
    const row = r as { id: number; clientId: string; name: string; createdAt: Date | string };
    return {
      id: Number(row.id),
      clientId: row.clientId,
      name: row.name,
      createdAt: toIsoOrNull(row.createdAt)!,
    };
  });
}

// Re-export the items table for tests that need to count rows.
export { items };
