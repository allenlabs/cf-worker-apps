// Database impls (Phase 3). Pure functions over a postgres.js `Sql` client,
// mirroring the page-tree handlers in pages.ts.
//
// Data model (see drizzle-pg/0003_databases.sql):
//   editor.pages (kind='database')  — the database itself (also a tree page)
//   editor.pages (kind='page', database_id set, db_props jsonb)
//                                    — the database's rows (each a real page)
//   editor.db_properties             — column definitions (text|number|…)
//   editor.db_views                  — saved views (table|board) + their config
//
// A row's title is the page title (the implicit "Name" column). db_props is a
// jsonb map keyed by property id. Rows are excluded from the page tree by the
// `database_id IS NULL` guard in pageTreeImpl.

import type { Sql } from '../lib/db';
import { createPageImpl } from './pages';

/**
 * Wrap a plain object as a jsonb parameter. postgres.js' `sql.json` types its
 * argument as `JSONValue`; our config/props maps are `Record<string, unknown>`
 * (genuinely JSON at runtime), so we narrow with a single local cast here
 * instead of sprinkling casts across every call site.
 */
function jsonb(sql: Sql, value: Record<string, unknown>) {
  return sql.json(value as Parameters<Sql['json']>[0]);
}

// ---------- shapes ----------

export type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'url'
  | 'email'
  | 'phone';

export interface DbProperty {
  id: string;
  databaseId: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  position: number;
}

export interface DbView {
  id: string;
  databaseId: string;
  name: string;
  type: string; // 'table' | 'board'
  config: Record<string, unknown>;
  position: number;
}

export interface DbSchema {
  database: { id: string; title: string };
  properties: DbProperty[];
  views: DbView[];
}

export interface DbRow {
  id: string;
  title: string;
  props: Record<string, unknown>;
}

interface ViewConfig {
  filters?: { propId: string; op?: string; value?: unknown }[];
  sorts?: { propId: string; dir?: 'asc' | 'desc' }[];
  groupBy?: string;
  visible?: string[];
}

// ---------- helpers ----------

/** Resolve the kind of a page (null when it doesn't exist / is archived). */
async function pageKindImpl(sql: Sql, id: string): Promise<string | null> {
  const [row] = await sql<{ kind: string }[]>`
    SELECT kind FROM editor.pages WHERE id = ${id} AND archived = false LIMIT 1
  `;
  return row?.kind ?? null;
}

/** Resolve the database a property belongs to (null when not found). */
export async function propertyDatabaseImpl(sql: Sql, propertyId: string): Promise<string | null> {
  const [row] = await sql<{ databaseId: string }[]>`
    SELECT database_id AS "databaseId" FROM editor.db_properties WHERE id = ${propertyId} LIMIT 1
  `;
  return row?.databaseId ?? null;
}

/** Resolve the database a view belongs to (null when not found). */
export async function viewDatabaseImpl(sql: Sql, viewId: string): Promise<string | null> {
  const [row] = await sql<{ databaseId: string }[]>`
    SELECT database_id AS "databaseId" FROM editor.db_views WHERE id = ${viewId} LIMIT 1
  `;
  return row?.databaseId ?? null;
}

/** Resolve the database a row (page) belongs to (null when not a row). */
export async function rowDatabaseImpl(sql: Sql, rowId: string): Promise<string | null> {
  const [row] = await sql<{ databaseId: string | null }[]>`
    SELECT database_id AS "databaseId" FROM editor.pages WHERE id = ${rowId} LIMIT 1
  `;
  return row?.databaseId ?? null;
}

// ---------- create database ----------

/**
 * Create a database (a page with kind='database') in `workspaceId`, then seed
 * a default Table view + two starter properties (a 'Status' select and a
 * 'Date' date). Returns the new database page id.
 */
export async function createDatabaseImpl(
  sql: Sql,
  ownerId: string,
  input: { workspaceId: string; parentId?: string | null; title?: string },
): Promise<{ id: string }> {
  const created = await createPageImpl(sql, ownerId, {
    workspaceId: input.workspaceId,
    parentId: input.parentId ?? null,
    title: input.title?.trim() || 'Untitled database',
  });
  await sql`UPDATE editor.pages SET kind = 'database' WHERE id = ${created.id}`;

  // Seed a default Table view.
  await sql`
    INSERT INTO editor.db_views (database_id, name, type, config, position)
    VALUES (${created.id}, 'Table', 'table', ${jsonb(sql, {})}, 0)
  `;

  // Seed two starter properties.
  await sql`
    INSERT INTO editor.db_properties (database_id, name, type, config, position)
    VALUES (
      ${created.id}, 'Status', 'select',
      ${jsonb(sql, {
        options: [
          { id: 'todo', name: 'To-do', color: 'gray' },
          { id: 'doing', name: 'Doing', color: 'blue' },
          { id: 'done', name: 'Done', color: 'green' },
        ],
      })},
      0
    )
  `;
  await sql`
    INSERT INTO editor.db_properties (database_id, name, type, config, position)
    VALUES (${created.id}, 'Date', 'date', ${jsonb(sql, {})}, 1)
  `;

  return { id: created.id };
}

// ---------- schema ----------

export async function dbSchemaImpl(sql: Sql, databaseId: string): Promise<DbSchema | null> {
  if ((await pageKindImpl(sql, databaseId)) !== 'database') return null;
  const [page] = await sql<{ id: string; title: string }[]>`
    SELECT id, title FROM editor.pages WHERE id = ${databaseId} LIMIT 1
  `;
  if (!page) return null;
  const properties = await listPropertiesImpl(sql, databaseId);
  const views = await listViewsImpl(sql, databaseId);
  return { database: { id: page.id, title: page.title }, properties, views };
}

export async function listPropertiesImpl(sql: Sql, databaseId: string): Promise<DbProperty[]> {
  const rows = await sql<
    {
      id: string;
      databaseId: string;
      name: string;
      type: string;
      config: Record<string, unknown>;
      position: number;
    }[]
  >`
    SELECT id, database_id AS "databaseId", name, type, config, position
    FROM editor.db_properties
    WHERE database_id = ${databaseId}
    ORDER BY position ASC, name ASC
  `;
  return rows.map((r) => ({ ...r, position: Number(r.position) }));
}

export async function listViewsImpl(sql: Sql, databaseId: string): Promise<DbView[]> {
  const rows = await sql<
    {
      id: string;
      databaseId: string;
      name: string;
      type: string;
      config: Record<string, unknown>;
      position: number;
    }[]
  >`
    SELECT id, database_id AS "databaseId", name, type, config, position
    FROM editor.db_views
    WHERE database_id = ${databaseId}
    ORDER BY position ASC, name ASC
  `;
  return rows.map((r) => ({ ...r, position: Number(r.position) }));
}

// ---------- properties ----------

export async function addPropertyImpl(
  sql: Sql,
  input: { databaseId: string; name: string; type: PropertyType; config?: Record<string, unknown> },
): Promise<DbProperty> {
  const [maxRow] = await sql<{ maxPos: number | null }[]>`
    SELECT MAX(position) AS "maxPos" FROM editor.db_properties WHERE database_id = ${input.databaseId}
  `;
  const position = Number(maxRow?.maxPos ?? -1) + 1;
  const [row] = await sql<
    {
      id: string;
      databaseId: string;
      name: string;
      type: string;
      config: Record<string, unknown>;
      position: number;
    }[]
  >`
    INSERT INTO editor.db_properties (database_id, name, type, config, position)
    VALUES (${input.databaseId}, ${input.name.trim() || 'Property'}, ${input.type},
            ${jsonb(sql, input.config ?? {})}, ${position})
    RETURNING id, database_id AS "databaseId", name, type, config, position
  `;
  if (!row) throw new Error('addPropertyImpl: insert returned no row');
  return { ...row, position: Number(row.position) };
}

export async function updatePropertyImpl(
  sql: Sql,
  id: string,
  patch: { name?: string; type?: PropertyType; config?: Record<string, unknown> },
): Promise<boolean> {
  const assign: Record<string, unknown> = {};
  if (typeof patch.name === 'string') assign.name = patch.name.trim() || 'Property';
  if (typeof patch.type === 'string') assign.type = patch.type;
  if (patch.config !== undefined) assign.config = jsonb(sql, patch.config);
  if (Object.keys(assign).length === 0) {
    return (await propertyDatabaseImpl(sql, id)) !== null;
  }
  const cols = Object.keys(assign);
  const rows = await sql`
    UPDATE editor.db_properties SET ${sql(assign, ...cols)} WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

export async function deletePropertyImpl(sql: Sql, id: string): Promise<boolean> {
  // Strip the property from every row's db_props (best-effort cleanup).
  const dbId = await propertyDatabaseImpl(sql, id);
  if (dbId) {
    await sql`
      UPDATE editor.pages
      SET db_props = db_props - ${id}
      WHERE database_id = ${dbId} AND db_props ? ${id}
    `;
  }
  const rows = await sql`DELETE FROM editor.db_properties WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------- views ----------

export async function addViewImpl(
  sql: Sql,
  input: { databaseId: string; type: string; name?: string; config?: Record<string, unknown> },
): Promise<DbView> {
  const [maxRow] = await sql<{ maxPos: number | null }[]>`
    SELECT MAX(position) AS "maxPos" FROM editor.db_views WHERE database_id = ${input.databaseId}
  `;
  const position = Number(maxRow?.maxPos ?? -1) + 1;
  const type = input.type === 'board' ? 'board' : 'table';
  const name = input.name?.trim() || (type === 'board' ? 'Board' : 'Table');
  const [row] = await sql<
    {
      id: string;
      databaseId: string;
      name: string;
      type: string;
      config: Record<string, unknown>;
      position: number;
    }[]
  >`
    INSERT INTO editor.db_views (database_id, name, type, config, position)
    VALUES (${input.databaseId}, ${name}, ${type}, ${jsonb(sql, input.config ?? {})}, ${position})
    RETURNING id, database_id AS "databaseId", name, type, config, position
  `;
  if (!row) throw new Error('addViewImpl: insert returned no row');
  return { ...row, position: Number(row.position) };
}

export async function updateViewImpl(
  sql: Sql,
  id: string,
  patch: { name?: string; config?: Record<string, unknown> },
): Promise<boolean> {
  const assign: Record<string, unknown> = {};
  if (typeof patch.name === 'string') assign.name = patch.name.trim() || 'View';
  if (patch.config !== undefined) assign.config = jsonb(sql, patch.config);
  if (Object.keys(assign).length === 0) {
    return (await viewDatabaseImpl(sql, id)) !== null;
  }
  const cols = Object.keys(assign);
  const rows = await sql`
    UPDATE editor.db_views SET ${sql(assign, ...cols)} WHERE id = ${id} RETURNING id
  `;
  return rows.length > 0;
}

export async function deleteViewImpl(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`DELETE FROM editor.db_views WHERE id = ${id} RETURNING id`;
  return rows.length > 0;
}

// ---------- rows ----------

/** Compare two cell values for sorting; null/undefined sort last. */
function compareValues(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** True iff the row passes a single equality/contains filter clause. */
function passesFilter(row: DbRow, clause: { propId: string; value?: unknown }): boolean {
  if (clause.value === undefined || clause.value === null || clause.value === '') return true;
  const cell = row.props[clause.propId];
  if (Array.isArray(cell)) return cell.map(String).includes(String(clause.value));
  if (typeof cell === 'boolean') return cell === Boolean(clause.value);
  return String(cell ?? '').toLowerCase().includes(String(clause.value).toLowerCase());
}

/**
 * Return non-archived rows of a database. Applies the named view's simple
 * filters + sorts in app-space (props live in jsonb; keeping it correct beats
 * clever SQL). The implicit "title" sort key is supported via propId='title'.
 */
export async function dbRowsImpl(
  sql: Sql,
  databaseId: string,
  viewId?: string,
): Promise<DbRow[]> {
  const raw = await sql<{ id: string; title: string; props: Record<string, unknown> }[]>`
    SELECT id, title, db_props AS props
    FROM editor.pages
    WHERE database_id = ${databaseId} AND archived = false
    ORDER BY position ASC, created_at ASC
  `;
  let rows: DbRow[] = raw.map((r) => ({ id: r.id, title: r.title, props: r.props ?? {} }));

  if (!viewId) return rows;
  const [view] = await sql<{ config: ViewConfig | null }[]>`
    SELECT config FROM editor.db_views WHERE id = ${viewId} AND database_id = ${databaseId} LIMIT 1
  `;
  const config = view?.config ?? {};

  for (const clause of config.filters ?? []) {
    rows = rows.filter((r) => passesFilter(r, clause));
  }

  const sorts = config.sorts ?? [];
  if (sorts.length > 0) {
    rows = [...rows].sort((ra, rb) => {
      for (const s of sorts) {
        const va = s.propId === 'title' ? ra.title : ra.props[s.propId];
        const vb = s.propId === 'title' ? rb.title : rb.props[s.propId];
        const cmp = compareValues(va, vb);
        if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
      }
      return 0;
    });
  }
  return rows;
}

export async function addRowImpl(
  sql: Sql,
  ownerId: string,
  input: { databaseId: string; title?: string },
): Promise<DbRow> {
  // Rows are pages parented to the database page, with kind='page'.
  const [wsRow] = await sql<{ workspaceId: string }[]>`
    SELECT workspace_id AS "workspaceId" FROM editor.pages WHERE id = ${input.databaseId} LIMIT 1
  `;
  if (!wsRow) throw new Error('addRowImpl: database page not found');
  const created = await createPageImpl(sql, ownerId, {
    workspaceId: wsRow.workspaceId,
    parentId: input.databaseId,
    title: input.title?.trim() || 'Untitled',
  });
  await sql`UPDATE editor.pages SET database_id = ${input.databaseId} WHERE id = ${created.id}`;
  return { id: created.id, title: created.title, props: {} };
}

export async function updateRowImpl(
  sql: Sql,
  id: string,
  patch: { title?: string; props?: Record<string, unknown> },
): Promise<boolean> {
  let touched = false;
  if (typeof patch.title === 'string') {
    const rows = await sql`
      UPDATE editor.pages SET title = ${patch.title.trim() || 'Untitled'}, updated_at = now()
      WHERE id = ${id} AND database_id IS NOT NULL AND archived = false
      RETURNING id
    `;
    if (rows.length > 0) touched = true;
  }
  if (patch.props !== undefined) {
    // Merge the patch into the existing jsonb map (shallow merge by key).
    const rows = await sql`
      UPDATE editor.pages
      SET db_props = db_props || ${jsonb(sql, patch.props)}, updated_at = now()
      WHERE id = ${id} AND database_id IS NOT NULL AND archived = false
      RETURNING id
    `;
    if (rows.length > 0) touched = true;
  }
  if (!touched && patch.title === undefined && patch.props === undefined) {
    // No-op patch: succeed iff the row exists.
    return (await rowDatabaseImpl(sql, id)) !== null;
  }
  return touched;
}

/** Archive a database row (soft delete; mirrors page archive). */
export async function deleteRowImpl(sql: Sql, id: string): Promise<boolean> {
  const rows = await sql`
    UPDATE editor.pages SET archived = true, updated_at = now()
    WHERE id = ${id} AND database_id IS NOT NULL AND archived = false
    RETURNING id
  `;
  return rows.length > 0;
}
