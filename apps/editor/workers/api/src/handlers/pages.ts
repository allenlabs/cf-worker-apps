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
import { captureVersionImpl } from './versions';
import { extractPageIds, reconcilePageLinksImpl } from './notify';

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
  kind: string; // 'page' | 'database'
  teamspaceId: string | null; // Phase 9 — null == default "Private" section
}

export interface PageFull {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  cover: string | null; // Phase 11 — optional banner image URL (null == none)
  snapshotHtml: string;
  kind: string; // 'page' | 'database'
  databaseId: string | null; // set when this page is a database row
  public: boolean; // Phase 4 — when true, reachable via the public share link
  restricted: boolean; // Phase 10 — when true, only owner + explicit shares can access
  fullWidth: boolean; // Phase 14 — render the page container edge-to-edge
  locked: boolean; // Phase 14 — when true the page is read-only for everyone
  isWiki: boolean; // Phase 15 — page is a wiki home (lists its sub-pages)
  verified: boolean; // Phase 15 — page marked verified
  verifiedBy: string | null; // Phase 15 — actor email who verified
  verifiedAt: string | null; // Phase 15 — when verified (ISO)
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

/**
 * True iff the user belongs to AT LEAST ONE workspace. Used to gate synced-block
 * collab tokens (Phase 12): a `sync-<uuid>` room is self-describing — possession
 * of the syncId (which you only obtain by being on a page that embeds the block)
 * is the access boundary — so we only require the requester to be a real,
 * provisioned suite user. Tighter per-sync ACL is a follow-up.
 */
export async function hasAnyMembershipImpl(sql: Sql, userId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM editor.workspace_members
    WHERE user_id = ${userId}
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

// Phase 9: a page can be shared directly to a single user (editor.page_shares),
// and that share PROPAGATES to descendant pages — opening a shared root grants
// access to its whole subtree. The depth cap matches isAncestorImpl's guard
// against accidentally-corrupt parent loops.
const SHARE_ANCESTOR_DEPTH = 1000;

/** Highest role ('owner'|'edit'|'view') the user holds over `pageId`, or null. */
export type PageRole = 'owner' | 'edit' | 'view';

/** The page-chain facts the access decision needs, resolved in one CTE. */
interface AccessFacts {
  /** workspace_id of the target page (null if the page doesn't exist). */
  workspaceId: string | null;
  /** owner_id of the TARGET page. */
  ownerId: string | null;
  /** Best explicit share role on the page or any ancestor for this user. */
  shareRole: 'edit' | 'view' | null;
  /** True if the page or any ancestor has restricted = true. */
  restricted: boolean;
  /**
   * Teamspace gating: true when some teamspace on the chain HAS members and the
   * user is NOT among them — workspace membership then doesn't grant access.
   */
  teamspaceBlocked: boolean;
}

/**
 * Resolve every fact the access decision needs in a single recursive CTE that
 * climbs parent_id from `pageId`. Folding restricted-inheritance, the best
 * ancestor share role, and per-teamspace gating into one walk keeps the policy
 * authoritative + avoids N round-trips.
 *
 * Teamspace gating: for each teamspace referenced on the chain that has ANY
 * teamspace_members rows, the user must have a membership row; if even one such
 * gated teamspace lacks the user, membership-based access is blocked. A
 * teamspace with no member rows is open (back-compat).
 */
async function accessFactsImpl(
  sql: Sql,
  userId: string,
  pageId: string,
): Promise<AccessFacts> {
  const [row] = await sql<
    {
      workspaceId: string | null;
      ownerId: string | null;
      shareRole: string | null;
      restricted: boolean;
      teamspaceBlocked: boolean;
    }[]
  >`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, owner_id, workspace_id, restricted, teamspace_id, 0 AS depth
      FROM editor.pages WHERE id = ${pageId}
      UNION ALL
      SELECT p.id, p.parent_id, p.owner_id, p.workspace_id, p.restricted, p.teamspace_id, c.depth + 1
      FROM editor.pages p
      JOIN chain c ON p.id = c.parent_id
      WHERE c.depth < ${SHARE_ANCESTOR_DEPTH}
    ),
    target AS (
      SELECT workspace_id, owner_id FROM chain WHERE depth = 0
    ),
    best_share AS (
      SELECT s.role
      FROM editor.page_shares s
      JOIN chain c ON c.id = s.page_id
      WHERE s.user_id = ${userId}
      ORDER BY CASE s.role WHEN 'edit' THEN 0 ELSE 1 END
      LIMIT 1
    ),
    -- A teamspace on the chain that has members but NOT this user blocks
    -- membership-based access.
    gated_teamspaces AS (
      SELECT DISTINCT c.teamspace_id AS ts
      FROM chain c
      WHERE c.teamspace_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM editor.teamspace_members m WHERE m.teamspace_id = c.teamspace_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM editor.teamspace_members m
          WHERE m.teamspace_id = c.teamspace_id AND m.user_id = ${userId}
        )
    )
    SELECT
      (SELECT workspace_id FROM target) AS "workspaceId",
      (SELECT owner_id FROM target) AS "ownerId",
      (SELECT role FROM best_share) AS "shareRole",
      COALESCE((SELECT bool_or(restricted) FROM chain), false) AS restricted,
      EXISTS (SELECT 1 FROM gated_teamspaces) AS "teamspaceBlocked"
  `;
  const shareRole =
    row?.shareRole === 'edit' ? 'edit' : row?.shareRole === 'view' ? 'view' : null;
  return {
    workspaceId: row?.workspaceId ?? null,
    ownerId: row?.ownerId ?? null,
    shareRole,
    restricted: row?.restricted ?? false,
    teamspaceBlocked: row?.teamspaceBlocked ?? false,
  };
}

/**
 * The user's effective role on `pageId`, authoritative for both read + write:
 *   - owner = the page's owner_id is this user (always full access, even when
 *     restricted).
 *   - edit  = a workspace member WITH access (not blocked by a restricted
 *     ancestor or a gated teamspace) OR an explicit 'edit' share on the page /
 *     an ancestor.
 *   - view  = an explicit 'view' share on the page / an ancestor (and not
 *     otherwise edit).
 *   - null  = no access.
 *
 * Restricted pages: when the page or an ancestor is restricted, workspace
 * membership alone does NOT grant access — only the owner + explicit shares.
 * Teamspace membership: when a teamspace on the chain has members, only its
 * members get membership-based access (see accessFactsImpl).
 */
export async function pageRoleImpl(
  sql: Sql,
  userId: string,
  pageId: string,
): Promise<PageRole | null> {
  const facts = await accessFactsImpl(sql, userId, pageId);
  if (!facts.workspaceId) return null;

  // Owner always wins (full access regardless of restriction / teamspace).
  if (facts.ownerId && facts.ownerId === userId) return 'owner';

  // Membership grants 'edit' unless blocked by a restricted ancestor or a gated
  // teamspace the user isn't in.
  const membershipGrants =
    !facts.restricted &&
    !facts.teamspaceBlocked &&
    (await isMemberImpl(sql, userId, facts.workspaceId));
  if (membershipGrants) return 'edit';

  // Otherwise fall back to an explicit share role on the page / an ancestor.
  if (facts.shareRole === 'edit') return 'edit';
  if (facts.shareRole === 'view') return 'view';
  return null;
}

/**
 * True iff the user can READ `pageId` — owner, an accessible workspace member,
 * or shared (view|edit). Read-level gate used by every membership-gated route.
 */
export async function canAccessPageImpl(
  sql: Sql,
  userId: string,
  pageId: string,
): Promise<boolean> {
  return (await pageRoleImpl(sql, userId, pageId)) !== null;
}

/** True iff `pageId` (the page itself) is locked. Missing page → false. */
export async function isPageLockedImpl(sql: Sql, pageId: string): Promise<boolean> {
  const [row] = await sql<{ locked: boolean }[]>`
    SELECT locked FROM editor.pages WHERE id = ${pageId} LIMIT 1
  `;
  return row?.locked ?? false;
}

/**
 * True iff the user can WRITE `pageId` — role is owner or edit. Use this on
 * every mutating route so a 'view'-shared user can't call write endpoints.
 *
 * Phase 14: a LOCKED page (the page itself; v1 doesn't climb ancestors) is
 * read-only for EVERYONE, so every content/structure write route gated by this
 * helper is refused while locked. The unlock toggle (/v1/pages/set-locked) does
 * NOT use this gate — it checks role directly — so a page can always be unlocked.
 */
export async function canEditPageImpl(
  sql: Sql,
  userId: string,
  pageId: string,
): Promise<boolean> {
  const role = await pageRoleImpl(sql, userId, pageId);
  const canWrite = role === 'owner' || role === 'edit';
  if (!canWrite) return false;
  return !(await isPageLockedImpl(sql, pageId));
}

/** Set/clear a page's `restricted` flag. Returns false if the page is missing. */
export async function setRestrictedImpl(
  sql: Sql,
  id: string,
  restricted: boolean,
): Promise<{ restricted: boolean } | null> {
  const rows = await sql<{ restricted: boolean }[]>`
    UPDATE editor.pages
    SET restricted = ${restricted}, updated_at = now()
    WHERE id = ${id}
    RETURNING restricted
  `;
  return rows[0] ? { restricted: rows[0].restricted } : null;
}

/** Set/clear a page's `locked` flag. Returns false if the page is missing. */
export async function setLockedImpl(
  sql: Sql,
  id: string,
  locked: boolean,
): Promise<{ locked: boolean } | null> {
  const rows = await sql<{ locked: boolean }[]>`
    UPDATE editor.pages
    SET locked = ${locked}, updated_at = now()
    WHERE id = ${id}
    RETURNING locked
  `;
  return rows[0] ? { locked: rows[0].locked } : null;
}

/**
 * Phase 15 — set/clear a page's `is_wiki` flag (turn a page into a wiki home
 * that lists its sub-pages as a directory). Returns null when the page is
 * missing.
 */
export async function setWikiImpl(
  sql: Sql,
  id: string,
  isWiki: boolean,
): Promise<{ isWiki: boolean } | null> {
  const rows = await sql<{ isWiki: boolean }[]>`
    UPDATE editor.pages
    SET is_wiki = ${isWiki}, updated_at = now()
    WHERE id = ${id}
    RETURNING is_wiki AS "isWiki"
  `;
  return rows[0] ? { isWiki: rows[0].isWiki } : null;
}

/**
 * Phase 15 — mark a page verified / unverified (wiki verified pages). When
 * verifying, stamp the actor's email + now; when unverifying, clear both.
 * Returns the new verification state, or null when the page is missing.
 */
export async function setVerifiedImpl(
  sql: Sql,
  id: string,
  verified: boolean,
  actorEmail: string | null,
): Promise<{ verified: boolean; verifiedBy: string | null; verifiedAt: string | null } | null> {
  const rows = await sql<
    { verified: boolean; verifiedBy: string | null; verifiedAt: string | null }[]
  >`
    UPDATE editor.pages
    SET verified = ${verified},
        verified_by = ${verified ? actorEmail : null},
        verified_at = ${verified ? sql`now()` : null},
        updated_at = now()
    WHERE id = ${id}
    RETURNING verified, verified_by AS "verifiedBy", verified_at AS "verifiedAt"
  `;
  if (!rows[0]) return null;
  return {
    verified: rows[0].verified,
    verifiedBy: rows[0].verifiedBy ?? null,
    verifiedAt: rows[0].verifiedAt ? String(rows[0].verifiedAt) : null,
  };
}

/** One child page in a wiki directory listing. */
export interface WikiEntry {
  id: string;
  title: string;
  icon: string | null;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

/**
 * Phase 15 — list the direct child pages of a wiki page as a directory, with
 * each child's verified state + last-edited time. Excludes database rows
 * (database_id set) so a wiki of databases still lists the DB pages but not
 * their rows. Ordered by position then title.
 */
export async function wikiEntriesImpl(sql: Sql, pageId: string): Promise<WikiEntry[]> {
  const rows = await sql<
    {
      id: string;
      title: string;
      icon: string | null;
      verified: boolean;
      verifiedBy: string | null;
      verifiedAt: string | null;
      updatedAt: string;
    }[]
  >`
    SELECT id, title, icon, verified,
           verified_by AS "verifiedBy", verified_at AS "verifiedAt",
           updated_at AS "updatedAt"
    FROM editor.pages
    WHERE parent_id = ${pageId} AND archived = false AND database_id IS NULL
    ORDER BY position ASC, title ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    verified: r.verified,
    verifiedBy: r.verifiedBy ?? null,
    verifiedAt: r.verifiedAt ? String(r.verifiedAt) : null,
    updatedAt: String(r.updatedAt),
  }));
}

/** True iff `userId` is the owner_id of `pageId`. */
export async function isPageOwnerImpl(
  sql: Sql,
  userId: string,
  pageId: string,
): Promise<boolean> {
  const [row] = await sql<{ ownerId: string | null }[]>`
    SELECT owner_id AS "ownerId" FROM editor.pages WHERE id = ${pageId} LIMIT 1
  `;
  return !!row && row.ownerId === userId;
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
    {
      id: string;
      title: string;
      icon: string | null;
      parentId: string | null;
      position: number;
      kind: string;
      teamspaceId: string | null;
    }[]
  >`
    SELECT id, title, icon, parent_id AS "parentId", position, kind,
           teamspace_id AS "teamspaceId"
    FROM editor.pages
    WHERE workspace_id = ${workspaceId} AND archived = false
      AND database_id IS NULL
    ORDER BY position ASC, created_at ASC
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    icon: r.icon,
    parentId: r.parentId,
    position: Number(r.position),
    kind: r.kind,
    teamspaceId: r.teamspaceId,
  }));
}

export interface CreatePageInput {
  workspaceId: string;
  parentId?: string | null;
  title?: string;
  icon?: string | null;
  /** Phase 9 — optional grouping for ROOT pages (ignored for nested pages). */
  teamspaceId?: string | null;
}

export async function createPageImpl(
  sql: Sql,
  ownerId: string,
  input: CreatePageInput,
): Promise<{ id: string; title: string; parentId: string | null }> {
  const safeTitle = (input.title ?? '').trim() || 'Untitled';
  const parentId = input.parentId ?? null;
  // A teamspace only groups ROOT pages; a nested page inherits its parent's
  // section, so never carry a teamspace id when a parent is set.
  const teamspaceId = parentId ? null : input.teamspaceId ?? null;
  // position = max sibling + 1 (siblings share the same parent within the ws).
  const [maxRow] = await sql<{ maxPos: number | null }[]>`
    SELECT MAX(position) AS "maxPos"
    FROM editor.pages
    WHERE workspace_id = ${input.workspaceId}
      AND parent_id IS NOT DISTINCT FROM ${parentId}
  `;
  const position = (Number(maxRow?.maxPos ?? -1)) + 1;
  const [row] = await sql<{ id: string; title: string; parentId: string | null }[]>`
    INSERT INTO editor.pages (workspace_id, parent_id, owner_id, title, icon, position, teamspace_id)
    VALUES (${input.workspaceId}, ${parentId}, ${ownerId}, ${safeTitle}, ${input.icon ?? null}, ${position}, ${teamspaceId})
    RETURNING id, title, parent_id AS "parentId"
  `;
  if (!row) throw new Error('createPageImpl: insert returned no row');
  // Phase 16 — a child page is a child-page reference from its parent, so seed
  // a backlink edge (parent → child). Reconcile of the parent's snapshot later
  // keeps it consistent if the block is removed.
  if (parentId) {
    await sql`
      INSERT INTO editor.page_links (source_page_id, target_page_id)
      VALUES (${parentId}, ${row.id})
      ON CONFLICT (source_page_id, target_page_id) DO NOTHING
    `;
  }
  return row;
}

export async function getPageImpl(sql: Sql, id: string): Promise<PageFull | null> {
  const [row] = await sql<PageFull[]>`
    SELECT id, workspace_id AS "workspaceId", parent_id AS "parentId",
           title, icon, cover, snapshot_html AS "snapshotHtml",
           kind, database_id AS "databaseId", public, restricted,
           full_width AS "fullWidth", locked,
           is_wiki AS "isWiki", verified,
           verified_by AS "verifiedBy", verified_at AS "verifiedAt"
    FROM editor.pages
    WHERE id = ${id} AND archived = false
    LIMIT 1
  `;
  return row ?? null;
}

export interface UpdatePageInput {
  title?: string;
  icon?: string | null;
  cover?: string | null;
  snapshotHtml?: string;
  /** Phase 14 — toggle the edge-to-edge wide layout. */
  fullWidth?: boolean;
  /** Attribution for any version row captured when snapshot_html changes. */
  author?: { id: string | null; name: string | null };
}

/**
 * Patch title/icon/snapshot on a page; bumps updated_at. Returns false if the
 * page doesn't exist (or is archived).
 *
 * When the patch carries a snapshot_html that DIFFERS from the page's current
 * one, the PREVIOUS snapshot is first captured as a version row (Phase 5) —
 * throttled + retention-capped inside captureVersionImpl.
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
  if (patch.cover !== undefined) assign.cover = patch.cover;
  if (typeof patch.fullWidth === 'boolean') assign.full_width = patch.fullWidth;
  if (typeof patch.snapshotHtml === 'string') {
    // Capture the previous snapshot as a version BEFORE overwriting it, but
    // only when the new html is genuinely different.
    const existing = await getPageImpl(sql, id);
    if (existing && existing.snapshotHtml !== patch.snapshotHtml) {
      await captureVersionImpl(sql, {
        pageId: id,
        previousHtml: existing.snapshotHtml,
        authorId: patch.author?.id ?? null,
        authorName: patch.author?.name ?? null,
      });
    }
    assign.snapshot_html = patch.snapshotHtml;
    // Phase 16 — reconcile the backlink graph from the new snapshot. Extract
    // referenced page ids (page-mention / child-page nodes + /p/<id> links)
    // and replace this page's outgoing links wholesale.
    await reconcilePageLinksImpl(sql, id, extractPageIds(patch.snapshotHtml, id));
  }
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
  /** Phase 9 — reassign a ROOT page's teamspace section (null clears it). */
  teamspaceId?: string | null;
}

/**
 * Reparent and/or reorder a page (and optionally restamp its teamspace section).
 * Guards against cycles: a page can't become its own descendant's child. Returns
 * false if not found; throws on a cycle.
 */
export async function movePageImpl(sql: Sql, input: MovePageInput): Promise<boolean> {
  const page = await getPageImpl(sql, input.id);
  if (!page) return false;

  const reparent = input.parentId !== undefined;
  const reorder = typeof input.position === 'number';
  const reteam = input.teamspaceId !== undefined;
  if (reparent && typeof input.parentId === 'string') {
    const newParent: string = input.parentId;
    if (newParent === input.id) throw new Error('movePageImpl: cannot parent a page to itself');
    // The new parent must not be the page itself or any of its descendants
    // (i.e. the page must not be an ancestor of the new parent).
    if (await isAncestorImpl(sql, input.id, newParent)) {
      throw new Error('movePageImpl: cycle — target is a descendant of the page');
    }
  }

  if (!reparent && !reorder && !reteam) return true; // nothing to change

  // Build the SET clause from only the present fields. A nested page never
  // carries a teamspace; reparenting under a parent clears any prior section.
  const assign: Record<string, unknown> = {};
  if (reparent) {
    assign.parent_id = input.parentId ?? null;
    if (input.parentId) assign.teamspace_id = null;
  }
  if (reorder) assign.position = input.position!;
  if (reteam && !(reparent && input.parentId)) {
    assign.teamspace_id = input.teamspaceId ?? null;
  }
  const cols = Object.keys(assign);
  const rows = await sql`
    UPDATE editor.pages
    SET ${sql(assign, ...cols)}, updated_at = now()
    WHERE id = ${input.id}
    RETURNING id
  `;
  return rows.length > 0;
}

// ---------- duplicate (Phase 14) ----------

/** One node in the subtree being duplicated (raw DB columns). */
interface DupRow {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  snapshotHtml: string;
  kind: string;
  databaseId: string | null;
  dbProps: Record<string, unknown>;
  position: number;
  teamspaceId: string | null;
}

/**
 * Deep-copy a page and its descendant subtree under a brand-new set of ids.
 *
 * The root copy is re-parented to the original's parent (a sibling) with
 * "Copy of " prefixed to its title; descendants keep their relative title +
 * parent links, remapped onto the new ids. We copy the presentation columns
 * (icon/cover/snapshot_html/kind/database_id/db_props), and for any
 * kind='database' page in the subtree we also clone its db_properties +
 * db_views.
 *
 * NOTE (v1): the live Yjs doc (keyed by page id) is NOT copied — the copy is
 * seeded from snapshot_html only, so the editor opens with the last-saved
 * content. Copying the Yjs state is a follow-up. (full_width/locked are
 * intentionally reset to their defaults on the copy.)
 *
 * Returns the new ROOT page id, or null if the source page doesn't exist.
 */
export async function duplicatePageImpl(
  sql: Sql,
  ownerId: string,
  id: string,
): Promise<{ id: string } | null> {
  const root = await getPageImpl(sql, id);
  if (!root) return null;

  // Fetch the whole subtree (root + descendants) in one walk.
  const rows = await sql<DupRow[]>`
    WITH RECURSIVE subtree AS (
      SELECT id, parent_id, title, icon, cover, snapshot_html, kind,
             database_id, db_props, position, teamspace_id, 0 AS depth
      FROM editor.pages WHERE id = ${id} AND archived = false
      UNION ALL
      SELECT p.id, p.parent_id, p.title, p.icon, p.cover, p.snapshot_html, p.kind,
             p.database_id, p.db_props, p.position, p.teamspace_id, s.depth + 1
      FROM editor.pages p
      JOIN subtree s ON p.parent_id = s.id
      WHERE s.depth < 1000 AND p.archived = false
    )
    SELECT id, parent_id AS "parentId", title, icon, cover,
           snapshot_html AS "snapshotHtml", kind, database_id AS "databaseId",
           db_props AS "dbProps", position, teamspace_id AS "teamspaceId"
    FROM subtree
  `;

  // Map every old id → a fresh uuid so parent/database links can be remapped.
  const idMap = new Map<string, string>();
  for (const r of rows) idMap.set(r.id, crypto.randomUUID());
  const remap = (old: string | null): string | null =>
    old === null ? null : idMap.get(old) ?? old;

  // Insert pages. The root's parent stays the original root's parent (sibling);
  // descendants remap their parent within the copied subtree. Only the root
  // gets the "Copy of " title prefix + carries the original's teamspace section.
  for (const r of rows) {
    const newId = idMap.get(r.id)!;
    const isRoot = r.id === id;
    const newParent = isRoot ? root.parentId : remap(r.parentId);
    const title = isRoot ? `Copy of ${r.title}` : r.title;
    // The root copy keeps its teamspace section; descendants inherit the parent.
    const teamspaceId = isRoot ? r.teamspaceId : null;
    await sql`
      INSERT INTO editor.pages
        (id, workspace_id, parent_id, owner_id, title, icon, cover, position,
         snapshot_html, kind, database_id, db_props, teamspace_id)
      VALUES (
        ${newId}, ${root.workspaceId}, ${newParent}, ${ownerId}, ${title},
        ${r.icon}, ${r.cover}, ${r.position}, ${r.snapshotHtml}, ${r.kind},
        ${remap(r.databaseId)}, ${sql.json(r.dbProps as Parameters<Sql['json']>[0])},
        ${teamspaceId}
      )
    `;
  }

  // For each database page copied, clone its property + view definitions onto
  // the new database id.
  for (const r of rows) {
    if (r.kind !== 'database') continue;
    const newDbId = idMap.get(r.id)!;
    await sql`
      INSERT INTO editor.db_properties (database_id, name, type, config, position)
      SELECT ${newDbId}, name, type, config, position
      FROM editor.db_properties WHERE database_id = ${r.id}
    `;
    await sql`
      INSERT INTO editor.db_views (database_id, name, type, config, position)
      SELECT ${newDbId}, name, type, config, position
      FROM editor.db_views WHERE database_id = ${r.id}
    `;
  }

  return { id: idMap.get(id)! };
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
