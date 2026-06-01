// Workspace + page-tree impls. Pure functions over a postgres.js `Sql` client
// so they're testable and free of Hono / Cloudflare runtime coupling.
//
// Data model (see drizzle-pg/0002_pages.sql):
//   workspaces        — named container owned by one user
//   workspace_members — membership rows (collaboration foundation)
//   pages             — the page tree (parent_id self-reference, position
//                       orders siblings, archived hides without deleting)
//
// A page's content lives in a Yjs doc keyed by the page id on allenlabs-collab
// (docId === pageId), so ids are never re-issued — only re-parented/re-ordered.

import type { Sql } from '../lib/db';

export interface Workspace {
  id: string;
  name: string;
}

export interface PageNode {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  position: number;
}

export interface PageFull {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  snapshotHtml: string;
}

// ---------- membership helpers ----------

export async function isMemberImpl(
  sql: Sql,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM editor.workspace_members
    WHERE workspace_id = ${workspaceId} AND user_id = ${userId}
    LIMIT 1
  `;
  return rows.length > 0;
}

/** Resolve the workspace a page belongs to (null if the page doesn't exist). */
export async function pageWorkspaceImpl(sql: Sql, pageId: string): Promise<string | null> {
  const [row] = await sql<{ workspaceId: string }[]>`
    SELECT workspace_id AS "workspaceId" FROM editor.pages
    WHERE id = ${pageId}
    LIMIT 1
  `;
  return row?.workspaceId ?? null;
}

/** True iff the user is a member of the workspace owning `pageId`. */
export async function canAccessPageImpl(
  sql: Sql,
  userId: string,
  pageId: string,
): Promise<boolean> {
  const workspaceId = await pageWorkspaceImpl(sql, pageId);
  if (!workspaceId) return false;
  return isMemberImpl(sql, userId, workspaceId);
}

// ---------- workspaces ----------

export async function listWorkspacesImpl(sql: Sql, userId: string): Promise<Workspace[]> {
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT w.id, w.name
    FROM editor.workspaces w
    JOIN editor.workspace_members m ON m.workspace_id = w.id
    WHERE m.user_id = ${userId}
    ORDER BY w.created_at ASC
  `;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Create a workspace owned by `userId` plus its owner membership row. */
export async function createWorkspaceImpl(
  sql: Sql,
  userId: string,
  name = 'My Workspace',
): Promise<Workspace> {
  const safeName = name.trim() || 'My Workspace';
  const [ws] = await sql<{ id: string; name: string }[]>`
    INSERT INTO editor.workspaces (name, owner_id)
    VALUES (${safeName}, ${userId})
    RETURNING id, name
  `;
  if (!ws) throw new Error('createWorkspaceImpl: insert returned no row');
  await sql`
    INSERT INTO editor.workspace_members (workspace_id, user_id, role)
    VALUES (${ws.id}, ${userId}, 'owner')
    ON CONFLICT DO NOTHING
  `;
  return ws;
}

/**
 * Return the user's workspaces, auto-provisioning a default one if they have
 * none — so a brand-new user always lands in a real workspace.
 */
export async function listOrProvisionWorkspacesImpl(
  sql: Sql,
  userId: string,
): Promise<Workspace[]> {
  const existing = await listWorkspacesImpl(sql, userId);
  if (existing.length > 0) return existing;
  const created = await createWorkspaceImpl(sql, userId);
  return [created];
}

// ---------- page tree ----------

/** All non-archived pages in a workspace as a flat array (web builds the tree). */
export async function pageTreeImpl(sql: Sql, workspaceId: string): Promise<PageNode[]> {
  const rows = await sql<
    { id: string; title: string; icon: string | null; parentId: string | null; position: number }[]
  >`
    SELECT id, title, icon, parent_id AS "parentId", position
    FROM editor.pages
    WHERE workspace_id = ${workspaceId} AND archived = false
    ORDER BY position ASC, created_at ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    parentId: r.parentId,
    position: Number(r.position),
  }));
}

export interface CreatePageInput {
  workspaceId: string;
  parentId?: string | null;
  title?: string;
  icon?: string | null;
}

export async function createPageImpl(
  sql: Sql,
  ownerId: string,
  input: CreatePageInput,
): Promise<{ id: string; title: string; parentId: string | null }> {
  const safeTitle = (input.title ?? '').trim() || 'Untitled';
  const parentId = input.parentId ?? null;
  // position = max sibling + 1 (siblings share the same parent within the ws).
  const [maxRow] = await sql<{ maxPos: number | null }[]>`
    SELECT MAX(position) AS "maxPos"
    FROM editor.pages
    WHERE workspace_id = ${input.workspaceId}
      AND parent_id IS NOT DISTINCT FROM ${parentId}
  `;
  const position = (Number(maxRow?.maxPos ?? -1)) + 1;
  const [row] = await sql<{ id: string; title: string; parentId: string | null }[]>`
    INSERT INTO editor.pages (workspace_id, parent_id, owner_id, title, icon, position)
    VALUES (${input.workspaceId}, ${parentId}, ${ownerId}, ${safeTitle}, ${input.icon ?? null}, ${position})
    RETURNING id, title, parent_id AS "parentId"
  `;
  if (!row) throw new Error('createPageImpl: insert returned no row');
  return row;
}

export async function getPageImpl(sql: Sql, id: string): Promise<PageFull | null> {
  const [row] = await sql<PageFull[]>`
    SELECT id, workspace_id AS "workspaceId", parent_id AS "parentId",
           title, icon, snapshot_html AS "snapshotHtml"
    FROM editor.pages
    WHERE id = ${id} AND archived = false
    LIMIT 1
  `;
  return row ?? null;
}

export interface UpdatePageInput {
  title?: string;
  icon?: string | null;
  snapshotHtml?: string;
}

/**
 * Patch title/icon/snapshot on a page; bumps updated_at. Returns false if the
 * page doesn't exist (or is archived).
 *
 * postgres.js expands a plain object passed to `sql(obj)` into `col = $n` pairs,
 * so we assemble only the columns present in the patch and append `updated_at`
 * via a trailing literal `now()` (kept out of the param object).
 */
export async function updatePageImpl(
  sql: Sql,
  id: string,
  patch: UpdatePageInput,
): Promise<boolean> {
  const assign: Record<string, unknown> = {};
  if (typeof patch.title === 'string') assign.title = patch.title.trim() || 'Untitled';
  if (patch.icon !== undefined) assign.icon = patch.icon;
  if (typeof patch.snapshotHtml === 'string') assign.snapshot_html = patch.snapshotHtml;
  if (Object.keys(assign).length === 0) {
    // No-op: succeed iff the page exists.
    return (await getPageImpl(sql, id)) !== null;
  }
  const cols = Object.keys(assign);
  const rows = await sql`
    UPDATE editor.pages
    SET ${sql(assign, ...cols)}, updated_at = now()
    WHERE id = ${id} AND archived = false
    RETURNING id
  `;
  return rows.length > 0;
}

/** True iff `ancestorId` is an ancestor of (or equal to) `pageId`. */
export async function isAncestorImpl(
  sql: Sql,
  ancestorId: string,
  pageId: string,
): Promise<boolean> {
  let current: string | null = pageId;
  // Walk parent links upward; the depth guard prevents an accidental loop in
  // already-corrupt data from spinning forever.
  for (let depth = 0; current && depth < 1000; depth++) {
    if (current === ancestorId) return true;
    // Copy into a separate const so the query param doesn't depend (even
    // indirectly) on the rows it produces — avoids a TS circular-inference error.
    const lookupId: string = current;
    const rows = await sql<{ parentId: string | null }[]>`
      SELECT parent_id AS "parentId" FROM editor.pages WHERE id = ${lookupId} LIMIT 1
    `;
    current = rows[0]?.parentId ?? null;
  }
  return false;
}

export interface MovePageInput {
  id: string;
  parentId?: string | null;
  position?: number;
}

/**
 * Reparent and/or reorder a page. Guards against cycles: a page can't become
 * its own descendant's child. Returns false if not found; throws on a cycle.
 */
export async function movePageImpl(sql: Sql, input: MovePageInput): Promise<boolean> {
  const page = await getPageImpl(sql, input.id);
  if (!page) return false;

  const reparent = input.parentId !== undefined;
  const reorder = typeof input.position === 'number';
  if (reparent && typeof input.parentId === 'string') {
    const newParent: string = input.parentId;
    if (newParent === input.id) throw new Error('movePageImpl: cannot parent a page to itself');
    // The new parent must not be the page itself or any of its descendants
    // (i.e. the page must not be an ancestor of the new parent).
    if (await isAncestorImpl(sql, input.id, newParent)) {
      throw new Error('movePageImpl: cycle — target is a descendant of the page');
    }
  }

  if (!reparent && !reorder) return true; // nothing to change

  const newParent = input.parentId ?? null;
  const rows =
    reparent && reorder
      ? await sql`
          UPDATE editor.pages
          SET parent_id = ${newParent}, position = ${input.position!}, updated_at = now()
          WHERE id = ${input.id}
          RETURNING id
        `
      : reparent
        ? await sql`
            UPDATE editor.pages
            SET parent_id = ${newParent}, updated_at = now()
            WHERE id = ${input.id}
            RETURNING id
          `
        : await sql`
            UPDATE editor.pages
            SET position = ${input.position!}, updated_at = now()
            WHERE id = ${input.id}
            RETURNING id
          `;
  return rows.length > 0;
}

/**
 * Archive a page and all of its descendants (recursive CTE). Returns false if
 * the page doesn't exist / is already archived.
 */
export async function archivePageImpl(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM editor.pages WHERE id = ${id}
      UNION ALL
      SELECT p.id FROM editor.pages p JOIN subtree s ON p.parent_id = s.id
    )
    UPDATE editor.pages
    SET archived = true, updated_at = now()
    WHERE id IN (SELECT id FROM subtree)
    RETURNING id
  `;
  return rows.length > 0;
}
