// Page version history impls (Phase 5). Pure functions over a postgres.js `Sql`
// client (same convention as pages.ts / db.ts / collab.ts).
//
// A "version" is a captured PREVIOUS snapshot_html of a page. The capture is
// driven from the snapshot-write path (recordVersionIfChangedImpl, called by
// updatePageImpl / updateRowImpl): before overwriting snapshot_html with a new,
// DIFFERENT value, we stash the old one here — throttled and retention-capped.
//
// Restore (restoreVersionImpl) rolls the page's snapshot_html back to a chosen
// version after first snapshotting the current state, so a restore is itself
// reversible. The live Yjs collab doc is a separate store and is NOT rewound.

import type { Sql } from '../lib/db';

/** Skip capturing a new version if the newest one is younger than this. */
const THROTTLE_MS = 60_000;
/** Keep at most this many versions per page; older ones are pruned. */
const MAX_VERSIONS = 50;

export interface VersionMeta {
  id: string;
  authorName: string | null;
  createdAt: string;
}

export interface VersionContent {
  snapshotHtml: string;
}

/** Resolve the page a version belongs to (null if the version doesn't exist). */
export async function versionPageImpl(sql: Sql, id: string): Promise<string | null> {
  const [row] = await sql<{ pageId: string }[]>`
    SELECT page_id AS "pageId" FROM editor.page_versions WHERE id = ${id} LIMIT 1
  `;
  return row?.pageId ?? null;
}

/** Trim a page's versions down to the newest MAX_VERSIONS rows. */
async function pruneVersionsImpl(sql: Sql, pageId: string): Promise<void> {
  await sql`
    DELETE FROM editor.page_versions
    WHERE page_id = ${pageId}
      AND id NOT IN (
        SELECT id FROM editor.page_versions
        WHERE page_id = ${pageId}
        ORDER BY created_at DESC
        LIMIT ${MAX_VERSIONS}
      )
  `;
}

/**
 * Capture `previousHtml` as a version of `pageId`, attributing it to the given
 * author — unless the newest existing version is younger than THROTTLE_MS (in
 * which case we skip, to avoid spamming on keystroke-driven snapshots). After a
 * capture, prune beyond MAX_VERSIONS. Returns true iff a version was written.
 *
 * The caller is responsible for only invoking this when the snapshot genuinely
 * changed; an empty previous snapshot ('') is skipped (nothing meaningful to
 * keep for a brand-new page's first edit).
 */
export async function captureVersionImpl(
  sql: Sql,
  input: { pageId: string; previousHtml: string; authorId: string | null; authorName: string | null },
): Promise<boolean> {
  if (input.previousHtml === '') return false;
  const [last] = await sql<{ ageMs: number }[]>`
    SELECT EXTRACT(EPOCH FROM (now() - created_at)) * 1000 AS "ageMs"
    FROM editor.page_versions
    WHERE page_id = ${input.pageId}
    ORDER BY created_at DESC
    LIMIT 1
  `;
  if (last && Number(last.ageMs) < THROTTLE_MS) return false;
  await sql`
    INSERT INTO editor.page_versions (page_id, snapshot_html, author_id, author_name)
    VALUES (${input.pageId}, ${input.previousHtml}, ${input.authorId}, ${input.authorName})
  `;
  await pruneVersionsImpl(sql, input.pageId);
  return true;
}

/** Newest-first version metadata for a page (no html bodies). */
export async function versionsListImpl(sql: Sql, pageId: string): Promise<VersionMeta[]> {
  const rows = await sql<{ id: string; authorName: string | null; createdAt: string }[]>`
    SELECT id, author_name AS "authorName", created_at AS "createdAt"
    FROM editor.page_versions
    WHERE page_id = ${pageId}
    ORDER BY created_at DESC
  `;
  return rows.map((r) => ({
    id: r.id,
    authorName: r.authorName,
    createdAt: String(r.createdAt),
  }));
}

/** Fetch one version's snapshot html (null if the version doesn't exist). */
export async function versionGetImpl(sql: Sql, id: string): Promise<VersionContent | null> {
  const [row] = await sql<{ snapshotHtml: string }[]>`
    SELECT snapshot_html AS "snapshotHtml" FROM editor.page_versions WHERE id = ${id} LIMIT 1
  `;
  return row ? { snapshotHtml: row.snapshotHtml } : null;
}

/**
 * Restore a page to a chosen version's snapshot_html. First captures the page's
 * CURRENT snapshot as a new version (so the restore is reversible), then writes
 * the chosen version's html back onto the page. Returns false if the version or
 * its page no longer exists.
 */
export async function restoreVersionImpl(
  sql: Sql,
  versionId: string,
  author: { authorId: string | null; authorName: string | null },
): Promise<boolean> {
  const target = await versionGetImpl(sql, versionId);
  if (!target) return false;
  const pageId = await versionPageImpl(sql, versionId);
  if (!pageId) return false;

  const [page] = await sql<{ snapshotHtml: string }[]>`
    SELECT snapshot_html AS "snapshotHtml" FROM editor.pages
    WHERE id = ${pageId} AND archived = false
    LIMIT 1
  `;
  if (!page) return false;

  // Snapshot the current state first (force-capture, bypassing the throttle so
  // a restore always leaves a recoverable point), then roll back.
  if (page.snapshotHtml !== '' && page.snapshotHtml !== target.snapshotHtml) {
    await sql`
      INSERT INTO editor.page_versions (page_id, snapshot_html, author_id, author_name)
      VALUES (${pageId}, ${page.snapshotHtml}, ${author.authorId}, ${author.authorName})
    `;
    await pruneVersionsImpl(sql, pageId);
  }
  await sql`
    UPDATE editor.pages SET snapshot_html = ${target.snapshotHtml}, updated_at = now()
    WHERE id = ${pageId} AND archived = false
  `;
  return true;
}
