// DataSource abstraction (Datasource Step 1).
//
// A `DataSource` is a server-side contract over the operations the editor's
// "Database" feature (Notion-style structured row collections) needs:
// property/view CRUD, row listing with the persisted view's filter/sort/group,
// and row CRUD. Today there is exactly one implementation — `PostgresDataSource`
// (workers/api/src/datasource/postgres.ts) — which delegates to the existing
// pure `*Impl(sql, …)` handlers in handlers/db.ts; behavior is unchanged.
//
// Step 2 will add a Durable-Object-SQLite `NativeDataSource`, and an external
// user-owned Postgres variant rides the same interface (see postgres.ts).
//
// The row/property/view SHAPES are re-exported verbatim from handlers/db.ts so
// the wire protocol stays identical — the interface is a thin contract over what
// the impls already return, NOT a new data model.

import type {
  DbProperty,
  DbView,
  DbSchema,
  DbRow,
  DbTemplate,
  PropertyType,
  DbRowsOptions,
} from '../handlers/db';

export type {
  DbProperty,
  DbView,
  DbSchema,
  DbRow,
  DbTemplate,
  PropertyType,
  DbRowsOptions,
};

/**
 * What a DataSource can do for a given database. Lets the server (and, via the
 * server-fn responses, the web client) gate UI affordances without hard-coding
 * "is this our native PG DB?" checks. The native PostgresDataSource reports
 * everything `true` / `readOnly: false`; an external read-only Postgres reports
 * the editing capabilities `false`.
 */
export interface Capabilities {
  /** Can new rows be inserted? */
  canCreateRow: boolean;
  /** Can existing rows' cells/title be edited? */
  canUpdateRow: boolean;
  /** Can rows be deleted (archived)? */
  canDeleteRow: boolean;
  /** Can columns (db_properties) be added? */
  canAddProperty: boolean;
  /** Can the schema (property type/config, views) be edited? */
  canEditSchema: boolean;
  /** Does a row carry an editable page body (snapshot_html / blocks)? */
  supportsPageBody: boolean;
  /** Are hierarchical sub-items (sub_item_parent_id) supported? */
  supportsSubItems: boolean;
  /** Are relation / rollup properties supported? */
  supportsRelations: boolean;
  /** Is the entire source read-only (no mutations of any kind)? */
  readOnly: boolean;
}

/** The full native capability set (our internal Postgres-backed databases). */
export const NATIVE_CAPABILITIES: Capabilities = {
  canCreateRow: true,
  canUpdateRow: true,
  canDeleteRow: true,
  canAddProperty: true,
  canEditSchema: true,
  supportsPageBody: true,
  supportsSubItems: true,
  supportsRelations: true,
  readOnly: false,
};

/** A read-leaning capability set for an external, user-owned Postgres. */
export const EXTERNAL_READONLY_CAPABILITIES: Capabilities = {
  canCreateRow: false,
  canUpdateRow: false,
  canDeleteRow: false,
  canAddProperty: false,
  canEditSchema: false,
  supportsPageBody: false,
  supportsSubItems: false,
  supportsRelations: false,
  readOnly: true,
};

// ---------- operation inputs ----------

export interface ListRowsInput {
  databaseId: string;
  /** Apply this saved view's filter/sort/group. */
  viewId?: string;
  /** Phase 15: read rows from this SOURCE database (linked views). */
  sourceDatabaseId?: string | null;
  /** Injected clock for relative-date filter operators (tests). */
  now?: number;
}

export interface CreateRowInput {
  databaseId: string;
  /** Acting user id — the new row page's owner. */
  ownerId: string;
  title?: string;
  /** Phase 15: seed the row by deep-copying this template. */
  templateId?: string | null;
  /** Phase 15: nest the new row under a parent row (sub-items). */
  subItemParentId?: string | null;
}

export interface UpdateRowInput {
  rowId: string;
  title?: string;
  props?: Record<string, unknown>;
}

export interface CreatePropertyInput {
  databaseId: string;
  name: string;
  type: PropertyType;
  config?: Record<string, unknown>;
}

export interface UpdatePropertyInput {
  id: string;
  name?: string;
  type?: PropertyType;
  config?: Record<string, unknown>;
}

export interface CreateViewInput {
  databaseId: string;
  type: string;
  name?: string;
  config?: Record<string, unknown>;
  sourceDatabaseId?: string | null;
}

export interface UpdateViewInput {
  id: string;
  name?: string;
  config?: Record<string, unknown>;
  sourceDatabaseId?: string | null;
}

/**
 * The server-side contract the `/v1/db/*` routes (and the web's DatabaseView via
 * server fns) drive. Method names + I/O shapes mirror the existing db.ts impls;
 * `PostgresDataSource` is a thin delegator. Step 2's `NativeDataSource` (DO
 * SQLite) implements the same surface.
 */
export interface DataSource {
  /** Capability flags for a database (or the source as a whole when omitted). */
  capabilities(databaseId?: string): Capabilities;

  // ----- rows -----
  /** List a database's rows, applying the named view's filter/sort/group. */
  listRows(input: ListRowsInput): Promise<DbRow[]>;
  /** Create a row (a page parented to the database). */
  createRow(input: CreateRowInput): Promise<DbRow>;
  /** Patch a row's title and/or cell props. Returns false when not a row. */
  updateRow(input: UpdateRowInput): Promise<boolean>;
  /** Soft-delete (archive) a row. Returns false when not a row. */
  deleteRow(rowId: string): Promise<boolean>;

  // ----- schema (properties) -----
  /** A database's column definitions, ordered by position. */
  listProperties(databaseId: string): Promise<DbProperty[]>;
  createProperty(input: CreatePropertyInput): Promise<DbProperty>;
  updateProperty(input: UpdatePropertyInput): Promise<boolean>;
  deleteProperty(id: string): Promise<boolean>;

  // ----- schema (views) -----
  /** A database's saved views, ordered by position. */
  listViews(databaseId: string): Promise<DbView[]>;
  createView(input: CreateViewInput): Promise<DbView>;
  updateView(input: UpdateViewInput): Promise<boolean>;
  deleteView(id: string): Promise<boolean>;

  // ----- combined schema (db page + properties + views) -----
  /** Full schema bundle, or null when `databaseId` isn't a database page. */
  schema(databaseId: string): Promise<DbSchema | null>;
}
