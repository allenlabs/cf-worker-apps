// Editor document impls. All read/write paths land here as pure functions
// over a postgres.js `Sql` client so they're testable (against a real or
// mock pg) and free of Hono / Cloudflare runtime coupling.

import type { Sql } from '../lib/db';
import type { AuthedUser } from '../context';

export interface DocListItem {
  id: string;
  title: string;
  updatedAt: string;
}

export interface DocFull {
  id: string;
  title: string;
  snapshotHtml: string;
  ownerId: string;
}

export interface MentionResult {
  id: string;
  label: string;
}

// ---------- user directory mirror ----------

export async function upsertUserImpl(sql: Sql, user: AuthedUser): Promise<void> {
  await sql`
    INSERT INTO editor.users (user_id, name, username, updated_at)
    VALUES (${user.userId}, ${user.userName}, ${user.username}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET name = EXCLUDED.name,
          username = EXCLUDED.username,
          updated_at = now()
  `;
}

// ---------- documents ----------

export async function listDocsImpl(sql: Sql, ownerId: string): Promise<DocListItem[]> {
  const rows = await sql<{ id: string; title: string; updatedAt: string }[]>`
    SELECT id, title, updated_at AS "updatedAt"
    FROM editor.documents
    WHERE owner_id = ${ownerId}
    ORDER BY updated_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    updatedAt: new Date(r.updatedAt as unknown as string | Date).toISOString(),
  }));
}

export async function createDocImpl(
  sql: Sql,
  ownerId: string,
  title: string,
): Promise<{ id: string; title: string }> {
  const safeTitle = title.trim() || 'Untitled';
  const [row] = await sql<{ id: string; title: string }[]>`
    INSERT INTO editor.documents (owner_id, title)
    VALUES (${ownerId}, ${safeTitle})
    RETURNING id, title
  `;
  if (!row) throw new Error('createDocImpl: insert returned no row');
  return row;
}

export async function getDocImpl(
  sql: Sql,
  ownerId: string,
  id: string,
): Promise<DocFull | null> {
  const [row] = await sql<DocFull[]>`
    SELECT id, title, snapshot_html AS "snapshotHtml", owner_id AS "ownerId"
    FROM editor.documents
    WHERE id = ${id} AND owner_id = ${ownerId}
    LIMIT 1
  `;
  return row ?? null;
}

export interface UpdateDocInput {
  title?: string;
  snapshotHtml?: string;
}

/** Update title and/or snapshot for an owned doc. Returns false if not owner. */
export async function updateDocImpl(
  sql: Sql,
  ownerId: string,
  id: string,
  patch: UpdateDocInput,
): Promise<boolean> {
  const hasTitle = typeof patch.title === 'string';
  const hasHtml = typeof patch.snapshotHtml === 'string';
  if (!hasTitle && !hasHtml) {
    // Nothing to change — treat as a successful no-op iff the doc is owned.
    const existing = await getDocImpl(sql, ownerId, id);
    return existing !== null;
  }
  const rows = hasTitle && hasHtml
    ? await sql`
        UPDATE editor.documents
        SET title = ${patch.title!}, snapshot_html = ${patch.snapshotHtml!}, updated_at = now()
        WHERE id = ${id} AND owner_id = ${ownerId}
        RETURNING id
      `
    : hasTitle
      ? await sql`
          UPDATE editor.documents
          SET title = ${patch.title!}, updated_at = now()
          WHERE id = ${id} AND owner_id = ${ownerId}
          RETURNING id
        `
      : await sql`
          UPDATE editor.documents
          SET snapshot_html = ${patch.snapshotHtml!}, updated_at = now()
          WHERE id = ${id} AND owner_id = ${ownerId}
          RETURNING id
        `;
  return rows.length > 0;
}

export async function deleteDocImpl(
  sql: Sql,
  ownerId: string,
  id: string,
): Promise<boolean> {
  const rows = await sql`
    DELETE FROM editor.documents
    WHERE id = ${id} AND owner_id = ${ownerId}
    RETURNING id
  `;
  return rows.length > 0;
}

// ---------- mention search ----------

export async function searchUsersImpl(sql: Sql, q: string): Promise<MentionResult[]> {
  const term = `%${q.trim()}%`;
  const rows = await sql<{ id: string; name: string; username: string | null }[]>`
    SELECT user_id AS id, name, username
    FROM editor.users
    WHERE name ILIKE ${term} OR username ILIKE ${term}
    ORDER BY name
    LIMIT 8
  `;
  return rows.map((r) => ({ id: r.id, label: r.name || r.username || r.id }));
}

// ---------- collab token (ownership check + payload) ----------

/** Verify the user owns docId. Returns true if the doc exists and is theirs. */
export async function ownsDocImpl(sql: Sql, ownerId: string, id: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM editor.documents
    WHERE id = ${id} AND owner_id = ${ownerId}
    LIMIT 1
  `;
  return rows.length > 0;
}
