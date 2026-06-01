// Phase 4 collaboration impls: favorites, trash, search, public sharing, and
// page-level comments. Pure functions over a postgres.js `Sql` client (same
// convention as pages.ts / db.ts) so they're testable and runtime-agnostic.
//
// Membership / access gating lives in the router (canAccessPageImpl /
// isMemberImpl from pages.ts); these impls assume the caller is authorised
// EXCEPT publicPageImpl, which is reachable with no auth and therefore enforces
// public=true itself.

import type { Sql } from '../lib/db';

// ---------- favorites ----------

export interface FavoriteItem {
  pageId: string;
  title: string;
  icon: string | null;
}

/** Starred, non-archived pages for a user (most-recently-starred first). */
export async function favListImpl(sql: Sql, userId: string): Promise<FavoriteItem[]> {
  const rows = await sql<{ pageId: string; title: string; icon: string | null }[]>`
    SELECT p.id AS "pageId", p.title, p.icon
    FROM editor.favorites f
    JOIN editor.pages p ON p.id = f.page_id
    WHERE f.user_id = ${userId} AND p.archived = false
    ORDER BY f.position ASC, f.created_at DESC
  `;
  return rows.map((r) => ({ pageId: r.pageId, title: r.title, icon: r.icon }));
}

/** Toggle a page's favorite state for a user. Returns the new state. */
export async function favToggleImpl(
  sql: Sql,
  userId: string,
  pageId: string,
): Promise<{ favorited: boolean }> {
  const deleted = await sql`
    DELETE FROM editor.favorites
    WHERE user_id = ${userId} AND page_id = ${pageId}
    RETURNING page_id
  `;
  if (deleted.length > 0) return { favorited: false };
  await sql`
    INSERT INTO editor.favorites (user_id, page_id)
    VALUES (${userId}, ${pageId})
    ON CONFLICT DO NOTHING
  `;
  return { favorited: true };
}

/** True iff the page is starred by the user (drives the page-header star). */
export async function isFavoritedImpl(
  sql: Sql,
  userId: string,
  pageId: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM editor.favorites
    WHERE user_id = ${userId} AND page_id = ${pageId}
    LIMIT 1
  `;
  return rows.length > 0;
}

// ---------- trash ----------

export interface TrashItem {
  id: string;
  title: string;
  icon: string | null;
}

/** Archived (top-level + nested) pages in a workspace, excluding database rows. */
export async function trashListImpl(sql: Sql, workspaceId: string): Promise<TrashItem[]> {
  const rows = await sql<{ id: string; title: string; icon: string | null }[]>`
    SELECT id, title, icon
    FROM editor.pages
    WHERE workspace_id = ${workspaceId} AND archived = true
      AND database_id IS NULL
    ORDER BY updated_at DESC
  `;
  return rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon }));
}

/** Un-archive a page (and its descendants). Returns false if nothing matched. */
export async function restorePageImpl(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM editor.pages WHERE id = ${id}
      UNION ALL
      SELECT p.id FROM editor.pages p JOIN subtree s ON p.parent_id = s.id
    )
    UPDATE editor.pages
    SET archived = false, updated_at = now()
    WHERE id IN (SELECT id FROM subtree)
    RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Hard-delete a page. Children, properties, comments, favorites, etc. all cascade
 * via their FKs (ON DELETE CASCADE). Returns false if the page didn't exist.
 */
export async function purgePageImpl(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM editor.pages WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

// ---------- search ----------

export interface SearchResult {
  id: string;
  title: string;
  icon: string | null;
  workspaceId: string;
}

/**
 * Up to 25 non-archived pages across the user's workspaces whose title OR
 * snapshot html matches `q` (case-insensitive). Empty/blank q → []. Database
 * rows are included (they're real pages) but databases-as-containers and rows
 * both surface by title.
 */
export async function searchImpl(sql: Sql, userId: string, q: string): Promise<SearchResult[]> {
  const term = q.trim();
  if (!term) return [];
  const like = `%${term}%`;
  const rows = await sql<{ id: string; title: string; icon: string | null; workspaceId: string }[]>`
    SELECT p.id, p.title, p.icon, p.workspace_id AS "workspaceId"
    FROM editor.pages p
    JOIN editor.workspace_members m ON m.workspace_id = p.workspace_id
    WHERE m.user_id = ${userId}
      AND p.archived = false
      AND (p.title ILIKE ${like} OR p.snapshot_html ILIKE ${like})
    ORDER BY p.updated_at DESC
    LIMIT 25
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    workspaceId: r.workspaceId,
  }));
}

// ---------- public sharing ----------

/** Set/clear a page's public flag. Returns the new value, or null if missing. */
export async function setPublicImpl(
  sql: Sql,
  id: string,
  isPublic: boolean,
): Promise<{ public: boolean } | null> {
  const rows = await sql<{ public: boolean }[]>`
    UPDATE editor.pages
    SET public = ${isPublic}, updated_at = now()
    WHERE id = ${id} AND archived = false
    RETURNING public
  `;
  const row = rows[0];
  return row ? { public: row.public } : null;
}

export interface PublicPage {
  title: string;
  icon: string | null;
  snapshotHtml: string;
}

/**
 * NO-AUTH read used by the public share link. Returns the page only when it
 * exists, is not archived, AND public=true — otherwise null (→ 404).
 */
export async function publicPageImpl(sql: Sql, id: string): Promise<PublicPage | null> {
  const [row] = await sql<{ title: string; icon: string | null; snapshotHtml: string }[]>`
    SELECT title, icon, snapshot_html AS "snapshotHtml"
    FROM editor.pages
    WHERE id = ${id} AND archived = false AND public = true
    LIMIT 1
  `;
  return row ?? null;
}

// ---------- comments ----------

export interface CommentItem {
  id: string;
  /** null = page-level comment; non-null = inline thread anchor (the mark's id). */
  threadId: string | null;
  authorName: string;
  body: string;
  resolved: boolean;
  createdAt: string;
}

type CommentRow = {
  id: string;
  threadId: string | null;
  authorName: string;
  body: string;
  resolved: boolean;
  createdAt: string;
};

function toCommentItem(r: CommentRow): CommentItem {
  return {
    id: r.id,
    threadId: r.threadId,
    authorName: r.authorName,
    body: r.body,
    resolved: r.resolved,
    createdAt: String(r.createdAt),
  };
}

/**
 * Comments on a page, oldest first. With `threadId` given, only that inline
 * thread; otherwise ALL comments (page-level + every inline thread) so the
 * panel can render both sections in one fetch.
 */
export async function commentsListImpl(
  sql: Sql,
  pageId: string,
  threadId?: string,
): Promise<CommentItem[]> {
  const rows =
    threadId === undefined
      ? await sql<CommentRow[]>`
          SELECT id, thread_id AS "threadId", author_name AS "authorName",
                 body, resolved, created_at AS "createdAt"
          FROM editor.comments
          WHERE page_id = ${pageId}
          ORDER BY created_at ASC
        `
      : await sql<CommentRow[]>`
          SELECT id, thread_id AS "threadId", author_name AS "authorName",
                 body, resolved, created_at AS "createdAt"
          FROM editor.comments
          WHERE page_id = ${pageId} AND thread_id = ${threadId}
          ORDER BY created_at ASC
        `;
  return rows.map(toCommentItem);
}

export interface AddCommentInput {
  pageId: string;
  userId: string;
  authorName: string;
  body: string;
  /** null/omitted → page-level comment; a UUID → append to that inline thread. */
  threadId?: string | null;
}

/** Insert a comment (page-level or inline); returns the created row. */
export async function commentAddImpl(sql: Sql, input: AddCommentInput): Promise<CommentItem> {
  const body = input.body.trim();
  const threadId = input.threadId ?? null;
  const [row] = await sql<CommentRow[]>`
    INSERT INTO editor.comments (page_id, user_id, author_name, body, thread_id)
    VALUES (${input.pageId}, ${input.userId}, ${input.authorName}, ${body}, ${threadId})
    RETURNING id, thread_id AS "threadId", author_name AS "authorName",
              body, resolved, created_at AS "createdAt"
  `;
  if (!row) throw new Error('commentAddImpl: insert returned no row');
  return toCommentItem(row);
}

/** Resolve / unresolve a single comment. Returns false if the comment is missing. */
export async function commentResolveImpl(
  sql: Sql,
  id: string,
  resolved: boolean,
): Promise<boolean> {
  const rows = await sql`
    UPDATE editor.comments SET resolved = ${resolved} WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Resolve / unresolve every comment in an inline thread. Returns false when the
 * thread has no comments on this page (nothing matched).
 */
export async function commentResolveThreadImpl(
  sql: Sql,
  pageId: string,
  threadId: string,
  resolved: boolean,
): Promise<boolean> {
  const rows = await sql`
    UPDATE editor.comments SET resolved = ${resolved}
    WHERE page_id = ${pageId} AND thread_id = ${threadId}
    RETURNING id
  `;
  return rows.length > 0;
}

export interface ThreadSummary {
  threadId: string;
  /** First (oldest) comment body in the thread — the margin/list snippet. */
  snippet: string;
  /** Number of comments in the thread. */
  count: number;
}

/**
 * Distinct OPEN (unresolved) inline threads on a page, each with its first
 * comment snippet + total count. Drives the thread list / margin indicators.
 * Page-level comments (thread_id NULL) are excluded.
 */
export async function commentThreadsImpl(sql: Sql, pageId: string): Promise<ThreadSummary[]> {
  const rows = await sql<{ threadId: string; snippet: string; count: number }[]>`
    SELECT thread_id AS "threadId",
           (array_agg(body ORDER BY created_at ASC))[1] AS snippet,
           count(*)::int AS count
    FROM editor.comments
    WHERE page_id = ${pageId} AND thread_id IS NOT NULL AND resolved = false
    GROUP BY thread_id
    ORDER BY min(created_at) ASC
  `;
  return rows.map((r) => ({
    threadId: r.threadId,
    snippet: r.snippet,
    count: Number(r.count),
  }));
}

/** Resolve the page a comment belongs to (null if the comment doesn't exist). */
export async function commentPageImpl(sql: Sql, id: string): Promise<string | null> {
  const [row] = await sql<{ pageId: string }[]>`
    SELECT page_id AS "pageId" FROM editor.comments WHERE id = ${id} LIMIT 1
  `;
  return row?.pageId ?? null;
}

/** Delete a comment. Returns false if the comment didn't exist. */
export async function commentDeleteImpl(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM editor.comments WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}
