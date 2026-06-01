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
import {
  parseFormula,
  evaluateFormula,
  isFormulaError,
  FormulaError,
  type Ast,
  type FormulaValue,
} from './formula';

/**
 * Wrap a plain object as a jsonb parameter. postgres.js' `sql.json` types its
 * argument as `JSONValue`; our config/props maps are `Record<string, unknown>`
 * (genuinely JSON at runtime), so we narrow with a single local cast here
 * instead of sprinkling casts across every call site.
 */
function jsonb(sql: Sql, value: Record<string, unknown>) {
  return sql.json(value as Parameters<Sql['json']>[0]);
}

/**
 * As `jsonb`, but for any JSON value (arrays, primitives) — used by the
 * dual-relation sync which writes a bare id string / id array into jsonb.
 */
function jsonbAny(sql: Sql, value: unknown) {
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
  | 'phone'
  | 'person'
  | 'files'
  // Phase 6: cross-database linking + aggregation.
  | 'relation'
  | 'rollup'
  // Phase 7: safe expression engine (computed read-only).
  | 'formula'
  // AUTO / read-only — derived from the row page, never stored in db_props.
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by';

/** Auto property types are computed from the row page, not from db_props. */
export const AUTO_PROPERTY_TYPES = new Set<string>([
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
]);

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

/**
 * Auto/meta fields derived from the row's page (not stored in db_props). Read
 * by created_time / created_by / last_edited_time / last_edited_by cells.
 */
export interface DbRowMeta {
  createdTime: string;
  lastEditedTime: string;
  createdById: string | null;
  createdByName: string | null;
}

/** A relation target resolved to a renderable chip. */
export interface RelationChip {
  id: string;
  title: string;
  icon?: string | null;
}

export interface DbRow {
  id: string;
  title: string;
  props: Record<string, unknown>;
  meta: DbRowMeta;
  // Phase 6: relation prop id → resolved target chips (parallel to props, which
  // still holds the raw string[] of ids). Only present for relation props.
  relations?: Record<string, RelationChip[]>;
  // Phase 6: rollup prop id → computed read-only value.
  rollups?: Record<string, unknown>;
  // Phase 7: formula prop id → computed read-only value (or { __error } sentinel).
  formulas?: Record<string, unknown>;
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

// ---------- relation / rollup support (Phase 6) ----------

/** A workspace database (a page with kind='database'), for relation pickers. */
export interface DatabaseListItem {
  id: string;
  title: string;
}

/** List non-archived databases in a workspace (for the relation target picker). */
export async function listDatabasesImpl(
  sql: Sql,
  workspaceId: string,
): Promise<DatabaseListItem[]> {
  const rows = await sql<{ id: string; title: string }[]>`
    SELECT id, title FROM editor.pages
    WHERE workspace_id = ${workspaceId} AND kind = 'database' AND archived = false
    ORDER BY title ASC, created_at ASC
  `;
  return rows.map((r) => ({ id: r.id, title: r.title }));
}

/**
 * Search a database's rows (pages with database_id set, not archived) by title.
 * Returns up to 20 lightweight chips for the relation cell picker. With no `q`
 * the most recent rows are returned.
 */
export async function relatedRowsImpl(
  sql: Sql,
  databaseId: string,
  q?: string,
): Promise<RelationChip[]> {
  const term = q && q.trim() ? `%${q.trim()}%` : null;
  const rows = term
    ? await sql<{ id: string; title: string; icon: string | null }[]>`
        SELECT id, title, icon FROM editor.pages
        WHERE database_id = ${databaseId} AND archived = false AND title ILIKE ${term}
        ORDER BY title ASC
        LIMIT 20
      `
    : await sql<{ id: string; title: string; icon: string | null }[]>`
        SELECT id, title, icon FROM editor.pages
        WHERE database_id = ${databaseId} AND archived = false
        ORDER BY created_at DESC
        LIMIT 20
      `;
  return rows.map((r) => ({ id: r.id, title: r.title, icon: r.icon }));
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
  const KNOWN_VIEW_TYPES = new Set(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']);
  const type = KNOWN_VIEW_TYPES.has(input.type) ? input.type : 'table';
  const DEFAULT_NAMES: Record<string, string> = {
    table: 'Table',
    board: 'Board',
    list: 'List',
    gallery: 'Gallery',
    calendar: 'Calendar',
    timeline: 'Timeline',
  };
  const name = input.name?.trim() || DEFAULT_NAMES[type] || 'View';
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

/** Coerce a cell value to a finite number (for numeric rollup fns), or null. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Coerce a cell value to an epoch-ms timestamp (for date rollup fns), or null. */
function toTime(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const t = new Date(value.length === 10 ? `${value}T00:00:00` : value).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Apply a rollup aggregation `fn` to the list of source values pulled from the
 * related rows' `targetPropId`. Returns a JSON-serializable computed value.
 * Supports a solid core and degrades gracefully (unknown fns → count).
 */
export function computeRollup(fn: string, values: unknown[]): unknown {
  const present = values.filter((v) => v !== null && v !== undefined && v !== '');
  switch (fn) {
    case 'count':
      return values.length;
    case 'count_values':
      return present.length;
    case 'show_unique':
      return new Set(present.map((v) => JSON.stringify(v))).size;
    case 'sum': {
      const nums = present.map(toNumber).filter((n): n is number => n !== null);
      return nums.reduce((a, b) => a + b, 0);
    }
    case 'average': {
      const nums = present.map(toNumber).filter((n): n is number => n !== null);
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
    }
    case 'median': {
      const nums = present.map(toNumber).filter((n): n is number => n !== null).sort((a, b) => a - b);
      if (!nums.length) return null;
      const mid = Math.floor(nums.length / 2);
      return nums.length % 2 ? nums[mid] : (nums[mid - 1]! + nums[mid]!) / 2;
    }
    case 'min': {
      const nums = present.map(toNumber).filter((n): n is number => n !== null);
      return nums.length ? Math.min(...nums) : null;
    }
    case 'max': {
      const nums = present.map(toNumber).filter((n): n is number => n !== null);
      return nums.length ? Math.max(...nums) : null;
    }
    case 'range': {
      const nums = present.map(toNumber).filter((n): n is number => n !== null);
      return nums.length ? Math.max(...nums) - Math.min(...nums) : null;
    }
    case 'earliest_date': {
      const times = present.map(toTime).filter((t): t is number => t !== null);
      return times.length ? new Date(Math.min(...times)).toISOString() : null;
    }
    case 'latest_date': {
      const times = present.map(toTime).filter((t): t is number => t !== null);
      return times.length ? new Date(Math.max(...times)).toISOString() : null;
    }
    case 'checked':
      return values.filter((v) => v === true).length;
    case 'unchecked':
      return values.filter((v) => v !== true).length;
    case 'percent_checked':
      return values.length ? values.filter((v) => v === true).length / values.length : null;
    case 'percent_unchecked':
      return values.length ? values.filter((v) => v !== true).length / values.length : null;
    default:
      // Unknown/unsupported fn → degrade to a count so the cell still renders.
      return values.length;
  }
}

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
 * A target row's fields, as needed to resolve a rollup's source value across
 * the supported `targetPropId` kinds (a stored prop, the title, or a meta date).
 */
interface TargetRowData {
  title: string;
  icon: string | null;
  props: Record<string, unknown>;
  createdTime: string;
  lastEditedTime: string;
}

/**
 * Resolve relation chips + compute rollups for a page of rows, using BATCHED
 * queries (one query for all referenced target ids — no N+1).
 *
 * - For each `relation` prop, `props[propId]` is a string[] of target row ids;
 *   we attach `row.relations[propId]` = resolved [{id,title,icon}] chips.
 * - For each `rollup` prop, we follow `config.relationPropId` → ids → read each
 *   target row's `config.targetPropId` value (a stored prop, 'title', or a
 *   created/last-edited meta date) and apply `config.fn`; result lands in
 *   `row.rollups[propId]`.
 */
async function resolveRelationsAndRollups(
  sql: Sql,
  databaseId: string,
  rows: DbRow[],
): Promise<void> {
  const properties = await listPropertiesImpl(sql, databaseId);
  const relationProps = properties.filter((p) => p.type === 'relation');
  const rollupProps = properties.filter((p) => p.type === 'rollup');
  if (relationProps.length === 0 && rollupProps.length === 0) return;

  // Map each relation prop id → its config (for the relationPropId lookup), so
  // a rollup can find the relation it rolls up. Build a quick prop index too.
  const propById = new Map(properties.map((p) => [p.id, p]));

  // Collect every target row id referenced across the whole page, from both
  // relation props directly and from the relations that rollups depend on.
  const relevantRelationIds = new Set<string>(relationProps.map((p) => p.id));
  for (const rp of rollupProps) {
    const relId = typeof rp.config.relationPropId === 'string' ? rp.config.relationPropId : '';
    if (relId) relevantRelationIds.add(relId);
  }

  const allTargetIds = new Set<string>();
  for (const row of rows) {
    for (const relPropId of relevantRelationIds) {
      const v = row.props[relPropId];
      if (Array.isArray(v)) {
        for (const id of v) if (typeof id === 'string') allTargetIds.add(id);
      }
    }
  }

  // Single batched fetch of every referenced target row (title/icon/props/meta).
  const targets = new Map<string, TargetRowData>();
  if (allTargetIds.size > 0) {
    const fetched = await sql<
      {
        id: string;
        title: string;
        icon: string | null;
        props: Record<string, unknown> | null;
        createdTime: string;
        lastEditedTime: string;
      }[]
    >`
      SELECT id, title, icon, db_props AS props,
             created_at AS "createdTime", updated_at AS "lastEditedTime"
      FROM editor.pages
      WHERE id IN ${sql([...allTargetIds])} AND archived = false
    `;
    for (const t of fetched) {
      targets.set(t.id, {
        title: t.title,
        icon: t.icon,
        props: t.props ?? {},
        createdTime: String(t.createdTime),
        lastEditedTime: String(t.lastEditedTime),
      });
    }
  }

  /** Read a target row's value for a rollup's `targetPropId`. */
  function targetValue(target: TargetRowData, targetPropId: string): unknown {
    if (targetPropId === 'title') return target.title;
    if (targetPropId === 'created_time') return target.createdTime;
    if (targetPropId === 'last_edited_time') return target.lastEditedTime;
    return target.props[targetPropId] ?? null;
  }

  for (const row of rows) {
    // Attach resolved chips for each relation prop (drop dangling ids).
    if (relationProps.length > 0) {
      const relations: Record<string, RelationChip[]> = {};
      for (const rp of relationProps) {
        const v = row.props[rp.id];
        const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        const chips: RelationChip[] = [];
        for (const id of ids) {
          const t = targets.get(id);
          if (t) chips.push({ id, title: t.title, icon: t.icon });
        }
        relations[rp.id] = chips;
      }
      row.relations = relations;
    }

    // Compute each rollup from its relation's target rows.
    if (rollupProps.length > 0) {
      const rollups: Record<string, unknown> = {};
      for (const rp of rollupProps) {
        const relId = typeof rp.config.relationPropId === 'string' ? rp.config.relationPropId : '';
        const targetPropId =
          typeof rp.config.targetPropId === 'string' ? rp.config.targetPropId : '';
        const fn = typeof rp.config.fn === 'string' ? rp.config.fn : 'count';
        if (!relId || !propById.has(relId)) {
          rollups[rp.id] = null;
          continue;
        }
        const v = row.props[relId];
        const ids = Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        const values = ids
          .map((id) => targets.get(id))
          .filter((t): t is TargetRowData => t !== undefined)
          .map((t) => targetValue(t, targetPropId));
        rollups[rp.id] = computeRollup(fn, values);
      }
      row.rollups = rollups;
    }
  }
}

// ---------- formula support (Phase 7) ----------

/**
 * Coerce a row's stored value for a property into a `FormulaValue` the engine
 * can work with. Mirrors the rendering coercions (select→option name,
 * relation→joined titles, checkbox→bool, etc.). Auto/meta props read from
 * `row.meta`. Rollups read from the precomputed `row.rollups` map. Formula
 * props are resolved separately (cycle-guarded) and never reach this helper.
 */
function coercePropForFormula(row: DbRow, prop: DbProperty): FormulaValue {
  switch (prop.type) {
    case 'created_time':
      return row.meta.createdTime || null;
    case 'last_edited_time':
      return row.meta.lastEditedTime || null;
    case 'created_by':
    case 'last_edited_by':
      return row.meta.createdByName ?? row.meta.createdById ?? null;
    case 'relation': {
      // Resolved chip titles joined; fall back to the raw id count.
      const chips = row.relations?.[prop.id];
      if (chips) return chips.map((c) => c.title || 'Untitled').join(', ');
      const raw = row.props[prop.id];
      return Array.isArray(raw) ? raw.length : 0;
    }
    case 'rollup': {
      const v = row.rollups?.[prop.id] ?? null;
      return coerceRaw(v);
    }
    default:
      break;
  }

  const value = row.props[prop.id] ?? null;
  switch (prop.type) {
    case 'number': {
      if (value === null || value === '') return null;
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case 'checkbox':
      return value === true;
    case 'select':
    case 'status': {
      if (typeof value !== 'string') return null;
      const options = (prop.config.options as { id: string; name: string }[] | undefined) ?? [];
      const opt = options.find((o) => o.id === value);
      return opt?.name ?? value;
    }
    case 'multi_select': {
      const options = (prop.config.options as { id: string; name: string }[] | undefined) ?? [];
      const ids = Array.isArray(value) ? (value as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      return ids.map((id) => options.find((o) => o.id === id)?.name ?? id).join(', ');
    }
    case 'files': {
      const files = Array.isArray(value) ? (value as { name?: string }[]) : [];
      return files.map((f) => f?.name ?? '').join(', ');
    }
    default:
      return coerceRaw(value);
  }
}

/** Coerce an arbitrary JSON value to a FormulaValue (booleans/numbers/strings). */
function coerceRaw(value: unknown): FormulaValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((v) => coerceRaw(v)).join(', ');
  return String(value);
}

/**
 * Parse + evaluate every formula property for a page of rows.
 *
 * - Builds a case-insensitive name→property index for the database.
 * - Parses each distinct expression ONCE (cache keyed by the expression string)
 *   so re-parsing across N rows is avoided.
 * - For each row, evaluates each formula against a context that resolves
 *   `prop("X")` / `{{X}}` by NAME (case-insensitive).
 * - Cycle handling: a formula MAY reference another formula property; we resolve
 *   referenced formulas recursively with a per-evaluation visited-set. Any
 *   cycle (a formula that transitively references itself) yields a typed error
 *   for that cell instead of looping. Self/forward refs that aren't cyclic
 *   resolve to their computed value.
 *
 * Results land in `row.formulas[propId]` as either the computed value or a
 * `{ __error }` sentinel; a single bad formula never throws out of here.
 */
function resolveFormulas(rows: DbRow[], properties: DbProperty[]): void {
  const formulaProps = properties.filter((p) => p.type === 'formula');
  if (formulaProps.length === 0) return;

  // Case-insensitive name → property (last write wins on dup names, matching
  // how the UI would surface them).
  const byLowerName = new Map<string, DbProperty>();
  for (const p of properties) byLowerName.set(p.name.toLowerCase(), p);

  // Parse cache: expression string → AST | FormulaError (parse failure).
  const astCache = new Map<string, Ast | FormulaError>();
  const astFor = (expr: string): Ast | FormulaError => {
    const hit = astCache.get(expr);
    if (hit !== undefined) return hit;
    let result: Ast | FormulaError;
    try {
      result = parseFormula(expr);
    } catch (err) {
      result = err instanceof FormulaError ? err : new FormulaError('Parse error');
    }
    astCache.set(expr, result);
    return result;
  };

  for (const row of rows) {
    const out: Record<string, unknown> = {};

    // Resolve a property by name into a FormulaValue, recursing into formula
    // props with a visited set to break cycles.
    const resolveByName = (name: string, visiting: Set<string>): FormulaValue => {
      const prop = byLowerName.get(name.toLowerCase());
      if (!prop) throw new FormulaError(`Unknown property "${name}"`);
      if (prop.type !== 'formula') return coercePropForFormula(row, prop);

      // A formula referencing a formula: guard against cycles.
      if (visiting.has(prop.id)) {
        throw new FormulaError(`Formula cycle via "${prop.name}"`);
      }
      const expr = typeof prop.config.expression === 'string' ? prop.config.expression : '';
      if (!expr.trim()) throw new FormulaError(`Formula "${prop.name}" is empty`);
      const ast = astFor(expr);
      if (ast instanceof FormulaError) throw ast;
      const nextVisiting = new Set(visiting);
      nextVisiting.add(prop.id);
      return evaluateFormula(ast, {
        resolveProp: (n) => resolveByName(n, nextVisiting),
      });
    };

    for (const fp of formulaProps) {
      const expr = typeof fp.config.expression === 'string' ? fp.config.expression : '';
      if (!expr.trim()) {
        out[fp.id] = { __error: 'Empty formula' };
        continue;
      }
      const ast = astFor(expr);
      if (ast instanceof FormulaError) {
        out[fp.id] = { __error: ast.message };
        continue;
      }
      try {
        const visiting = new Set<string>([fp.id]);
        const value = evaluateFormula(ast, {
          resolveProp: (n) => resolveByName(n, visiting),
        });
        // Dates serialize to ISO strings for JSON transport.
        out[fp.id] = value instanceof Date ? value.toISOString() : value;
      } catch (err) {
        out[fp.id] = { __error: err instanceof FormulaError ? err.message : 'Formula error' };
      }
    }
    row.formulas = out;
  }
}

/** Public, test-friendly helper: ensure isFormulaError is exported transitively. */
export { isFormulaError };

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
  // Join the user directory so created_by / last_edited_by auto cells can show
  // a name. Pages don't track a separate editor, so created_by and
  // last_edited_by both resolve to the page owner (best available signal).
  const raw = await sql<
    {
      id: string;
      title: string;
      props: Record<string, unknown>;
      createdTime: string;
      lastEditedTime: string;
      ownerId: string;
      ownerName: string | null;
    }[]
  >`
    SELECT p.id, p.title, p.db_props AS props,
           p.created_at AS "createdTime", p.updated_at AS "lastEditedTime",
           p.owner_id AS "ownerId", u.name AS "ownerName"
    FROM editor.pages p
    LEFT JOIN editor.users u ON u.user_id = p.owner_id
    WHERE p.database_id = ${databaseId} AND p.archived = false
    ORDER BY p.position ASC, p.created_at ASC
  `;
  let rows: DbRow[] = raw.map((r) => ({
    id: r.id,
    title: r.title,
    props: r.props ?? {},
    meta: {
      createdTime: String(r.createdTime),
      lastEditedTime: String(r.lastEditedTime),
      createdById: r.ownerId ?? null,
      createdByName: r.ownerName || r.ownerId || null,
    },
  }));

  // Phase 6: resolve relation chips + compute rollups with BATCHED queries.
  await resolveRelationsAndRollups(sql, databaseId, rows);

  // Phase 7: compute formula properties (after relations/rollups so formulas
  // can reference their computed values). Reuses the property list once.
  const properties = await listPropertiesImpl(sql, databaseId);
  resolveFormulas(rows, properties);

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
  // Freshly-created row: meta is filled on the next /db/rows read; return a
  // best-effort placeholder so the shape stays consistent.
  const nowIso = new Date().toISOString();
  return {
    id: created.id,
    title: created.title,
    props: {},
    meta: { createdTime: nowIso, lastEditedTime: nowIso, createdById: ownerId, createdByName: null },
  };
}

/**
 * Dual (two-way) relation sync. For each relation prop in `patch` that declares
 * a `dualPropertyId`, diff the added/removed target ids and mirror this row's id
 * into / out of each target row's reverse relation array. Best-effort: a missing
 * dualPropertyId or non-array value is simply skipped, so single-direction
 * relations behave exactly as before.
 */
async function syncDualRelations(
  sql: Sql,
  rowId: string,
  databaseId: string,
  beforeProps: Record<string, unknown>,
  patchProps: Record<string, unknown>,
): Promise<void> {
  const properties = await listPropertiesImpl(sql, databaseId);
  const relById = new Map(properties.filter((p) => p.type === 'relation').map((p) => [p.id, p]));

  for (const [propId, rawNext] of Object.entries(patchProps)) {
    const prop = relById.get(propId);
    if (!prop) continue;
    const dualPropId = typeof prop.config.dualPropertyId === 'string' ? prop.config.dualPropertyId : '';
    if (!dualPropId) continue;

    const asIds = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    const before = new Set(asIds(beforeProps[propId]));
    const after = new Set(asIds(rawNext));
    const added = [...after].filter((x) => !before.has(x));
    const removed = [...before].filter((x) => !after.has(x));

    for (const targetId of added) {
      // Append rowId to target.db_props[dualPropId] if not already present.
      await sql`
        UPDATE editor.pages
        SET db_props = jsonb_set(
              db_props,
              ARRAY[${dualPropId}],
              COALESCE(db_props -> ${dualPropId}, '[]'::jsonb) || ${jsonbAny(sql, [rowId])},
              true
            )
        WHERE id = ${targetId} AND archived = false
          AND NOT (COALESCE(db_props -> ${dualPropId}, '[]'::jsonb) ? ${rowId})
      `;
    }
    for (const targetId of removed) {
      // Remove rowId from target.db_props[dualPropId].
      await sql`
        UPDATE editor.pages
        SET db_props = jsonb_set(
              db_props,
              ARRAY[${dualPropId}],
              COALESCE(
                (SELECT jsonb_agg(e) FROM jsonb_array_elements(db_props -> ${dualPropId}) e
                 WHERE e <> ${jsonbAny(sql, rowId)}),
                '[]'::jsonb
              ),
              true
            )
        WHERE id = ${targetId} AND archived = false
          AND db_props ? ${dualPropId}
      `;
    }
  }
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
    // Read the prior props + the owning database first, so we can both merge
    // and (for dual relations) diff added/removed target ids.
    const [before] = await sql<{ props: Record<string, unknown> | null; databaseId: string | null }[]>`
      SELECT db_props AS props, database_id AS "databaseId" FROM editor.pages
      WHERE id = ${id} AND database_id IS NOT NULL AND archived = false LIMIT 1
    `;
    // Merge the patch into the existing jsonb map (shallow merge by key).
    const rows = await sql`
      UPDATE editor.pages
      SET db_props = db_props || ${jsonb(sql, patch.props)}, updated_at = now()
      WHERE id = ${id} AND database_id IS NOT NULL AND archived = false
      RETURNING id
    `;
    if (rows.length > 0) {
      touched = true;
      if (before?.databaseId) {
        await syncDualRelations(sql, id, before.databaseId, before.props ?? {}, patch.props);
      }
    }
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
