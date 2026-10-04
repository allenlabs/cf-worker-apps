// Phase 9 impls: per-user page sharing ("shared with me") + lightweight
// teamspaces. Pure functions over a postgres.js `Sql` client (same convention
// as pages.ts / collab.ts) so they're testable and runtime-agnostic.
//
// Access gating (canAccessPageImpl / isMemberImpl from pages.ts) lives in the
// router; these impls assume the caller is already authorised on the page /
// workspace they pass in.

import type { Sql } from '../lib/db';

export type ShareRole = 'view' | 'edit';

export interface SharedUser {
  userId: string;
  name: string;
  role: ShareRole;
}

export interface SharedWithMeItem {
  id: string;
  title: string;
  icon: string | null;
}

/**
 * Resolve a free-text query to a single suite user (editor.users mirror), then
 * upsert a page_shares row for them at `role`. Mirrors /v1/users/search
 * semantics: an exact name/username match wins, else the first by name. Returns
 * the shared user, or null when the query matched nobody.
 */
export async function shareePageImpl(
  sql: Sql,
  input: { pageId: string; query: string; role: ShareRole },
): Promise<SharedUser | null> {
  const term = input.query.trim();
  if (!term) return null;
  const like = `%${term}%`;
  // Prefer an exact (case-insensitive) name/username, then the first by name.
  const [user] = await sql<{ userId: string; name: string }[]>`
    SELECT user_id AS "userId", COALESCE(name, username, user_id) AS name
    FROM editor.users
    WHERE name ILIKE ${term} OR username ILIKE ${term}
       OR name ILIKE ${like} OR username ILIKE ${like}
    ORDER BY
      CASE WHEN name ILIKE ${term} OR username ILIKE ${term} THEN 0 ELSE 1 END,
      name
    LIMIT 1
  `;
  if (!user) return null;
  await sql`
    INSERT INTO editor.page_shares (page_id, user_id, role)
    VALUES (${input.pageId}, ${user.userId}, ${input.role})
    ON CONFLICT (page_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `;
  return { userId: user.userId, name: user.name, role: input.role };
}

/** Remove a user's share on a page. Returns false when nothing matched. */
export async function unsharePageImpl(
  sql: Sql,
  pageId: string,
  userId: string,
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM editor.page_shares
    WHERE page_id = ${pageId} AND user_id = ${userId}
    RETURNING page_id
  `;
  return rows.length > 0;
}

/** Users a page is directly shared with (name resolved from the user mirror). */
export async function pageSharesImpl(sql: Sql, pageId: string): Promise<SharedUser[]> {
  const rows = await sql<{ userId: string; name: string; role: string }[]>`
    SELECT s.user_id AS "userId",
           COALESCE(u.name, u.username, s.user_id) AS name,
           s.role
    FROM editor.page_shares s
    LEFT JOIN editor.users u ON u.user_id = s.user_id
    WHERE s.page_id = ${pageId}
    ORDER BY s.created_at ASC
  `;
  return rows.map((r) => ({
    userId: r.userId,
    name: r.name,
    role: r.role === 'edit' ? 'edit' : 'view',
  }));
}

/**
 * Root-level pages shared directly to the user, EXCLUDING any they can already
 * reach as a workspace member (those show in the normal tree). Drives the
 * sidebar's "Shared with me" section.
 */
export async function sharedWithMeImpl(sql: Sql, userId: string): Promise<SharedWithMeItem[]> {
  const rows = await sql<{ id: string; title: string; icon: string | null }[]>`
    SELECT p.id, p.title, p.icon
    FROM editor.page_shares s
    JOIN editor.pages p ON p.id = s.page_id
    WHERE s.user_id = ${userId}
      AND p.archived = false
      AND NOT EXISTS (
        SELECT 1 FROM editor.workspace_members m
        WHERE m.workspace_id = p.workspace_id AND m.user_id = ${userId}
      )
    ORDER BY p.updated_at DESC
  `;
  return rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon }));
}

// ---------- teamspaces ----------

export interface Teamspace {
  id: string;
  name: string;
}

/** Teamspaces in a workspace, ordered by position then creation. */
export async function teamspacesListImpl(sql: Sql, workspaceId: string): Promise<Teamspace[]> {
  const rows = await sql<{ id: string; name: string }[]>`
    SELECT id, name FROM editor.teamspaces
    WHERE workspace_id = ${workspaceId}
    ORDER BY position ASC, created_at ASC
  `;
  return rows.map((r) => ({ id: r.id, name: r.name }));
}

/** Create a teamspace; position = max + 1 within the workspace. */
export async function teamspaceCreateImpl(
  sql: Sql,
  workspaceId: string,
  name: string,
): Promise<Teamspace> {
  const safeName = name.trim() || 'Teamspace';
  const [maxRow] = await sql<{ maxPos: number | null }[]>`
    SELECT MAX(position) AS "maxPos" FROM editor.teamspaces WHERE workspace_id = ${workspaceId}
  `;
  const position = Number(maxRow?.maxPos ?? -1) + 1;
  const [row] = await sql<{ id: string; name: string }[]>`
    INSERT INTO editor.teamspaces (workspace_id, name, position)
    VALUES (${workspaceId}, ${safeName}, ${position})
    RETURNING id, name
  `;
  if (!row) throw new Error('teamspaceCreateImpl: insert returned no row');
  return row;
}

/** Rename a teamspace. Returns false when the id doesn't exist. */
export async function teamspaceRenameImpl(sql: Sql, id: string, name: string): Promise<boolean> {
  const safeName = name.trim() || 'Teamspace';
  const rows = await sql`
    UPDATE editor.teamspaces SET name = ${safeName} WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

/**
 * Delete a teamspace. Its pages survive — pages.teamspace_id FK is ON DELETE SET
 * NULL, so they fall back to the default "Private" section. Returns false when
 * the id didn't exist.
 */
export async function teamspaceDeleteImpl(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`
    DELETE FROM editor.teamspaces WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

/** Resolve the workspace a teamspace belongs to (null when missing). */
export async function teamspaceWorkspaceImpl(sql: Sql, id: string): Promise<string | null> {
  const [row] = await sql<{ workspaceId: string }[]>`
    SELECT workspace_id AS "workspaceId" FROM editor.teamspaces WHERE id = ${id} LIMIT 1
  `;
  return row?.workspaceId ?? null;
}

// ---------- teamspace membership (Phase 10) ----------
//
// Opt-in per-teamspace ACL: a teamspace with NO member rows stays open to all
// workspace members (Phase 9 back-compat); once it has ANY member rows, only
// those members get membership-based access to its pages (enforced in
// pageRoleImpl via accessFactsImpl).

export interface TeamspaceMember {
  userId: string;
  name: string;
  role: string;
}

/** Members of a teamspace (name resolved from the user mirror). */
export async function teamspaceMembersImpl(
  sql: Sql,
  teamspaceId: string,
): Promise<TeamspaceMember[]> {
  const rows = await sql<{ userId: string; name: string; role: string }[]>`
    SELECT m.user_id AS "userId",
           COALESCE(u.name, u.username, m.user_id) AS name,
           m.role
    FROM editor.teamspace_members m
    LEFT JOIN editor.users u ON u.user_id = m.user_id
    WHERE m.teamspace_id = ${teamspaceId}
    ORDER BY m.created_at ASC
  `;
  return rows.map((r) => ({ userId: r.userId, name: r.name, role: r.role }));
}

/**
 * Resolve a free-text query to a single suite user (same semantics as
 * shareePageImpl), then upsert a teamspace_members row for them. Returns the
 * added member, or null when the query matched nobody.
 */
export async function teamspaceMemberAddImpl(
  sql: Sql,
  input: { teamspaceId: string; query: string; role?: string },
): Promise<TeamspaceMember | null> {
  const term = input.query.trim();
  if (!term) return null;
  const like = `%${term}%`;
  const [user] = await sql<{ userId: string; name: string }[]>`
    SELECT user_id AS "userId", COALESCE(name, username, user_id) AS name
    FROM editor.users
    WHERE name ILIKE ${term} OR username ILIKE ${term}
       OR name ILIKE ${like} OR username ILIKE ${like}
    ORDER BY
      CASE WHEN name ILIKE ${term} OR username ILIKE ${term} THEN 0 ELSE 1 END,
      name
    LIMIT 1
  `;
  if (!user) return null;
  const role = input.role === 'admin' ? 'admin' : 'member';
  await sql`
    INSERT INTO editor.teamspace_members (teamspace_id, user_id, role)
    VALUES (${input.teamspaceId}, ${user.userId}, ${role})
    ON CONFLICT (teamspace_id, user_id) DO UPDATE SET role = EXCLUDED.role
  `;
  return { userId: user.userId, name: user.name, role };
}

/** Remove a user from a teamspace. Returns false when nothing matched. */
export async function teamspaceMemberRemoveImpl(
  sql: Sql,
  teamspaceId: string,
  userId: string,
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM editor.teamspace_members
    WHERE teamspace_id = ${teamspaceId} AND user_id = ${userId}
    RETURNING teamspace_id
  `;
  return rows.length > 0;
}
