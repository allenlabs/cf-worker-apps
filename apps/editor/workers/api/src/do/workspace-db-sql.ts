// Pure SQL schema + row-mapping helpers for the WorkspaceDB Durable Object.
//
// Split out from workspace-db.ts so the schema DDL + the stored-row → DbRow
// mapping are unit-testable in the node project WITHOUT the workers pool (the
// live SQLite needs @cloudflare/vitest-pool-workers). The DO calls these; the
// behavior-critical mapping (`rowFromStored`) is what NativeDataSource's output
// shape depends on, so it's covered directly in node.

import type { DbRow } from '../handlers/db';

/** RPC input: register/upsert a native database container. */
export interface CreateDatabaseRpc {
  id: string;
  title?: string;
  icon?: string | null;
  /** Seed default Table view + Status/Date props (default true). */
  seedDefaults?: boolean;
}

export interface CreatePropertyRpc {
  databaseId: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
}

export interface UpdatePropertyRpc {
  id: string;
  name?: string;
  type?: string;
  config?: Record<string, unknown>;
}

export interface CreateViewRpc {
  databaseId: string;
  type: string;
  name?: string;
  config?: Record<string, unknown>;
  sourceDatabaseId?: string | null;
}

export interface UpdateViewRpc {
  id: string;
  name?: string;
  config?: Record<string, unknown>;
  sourceDatabaseId?: string | null;
}

export interface CreateRowRpc {
  databaseId: string;
  ownerId: string;
  title?: string;
  templateId?: string | null;
  subItemParentId?: string | null;
}

export interface UpdateRowRpc {
  rowId: string;
  title?: string;
  props?: Record<string, unknown>;
  lastEditedBy?: string | null;
}

/** A row row as stored in the DO's `rows` table (props is a JSON TEXT column). */
export interface StoredRow {
  id: string;
  title: string;
  icon: string | null;
  props: string;
  subItemParentId: string | null;
  createdTime: string;
  lastEditedTime: string;
  createdBy: string | null;
  lastEditedBy: string | null;
}

/**
 * The idempotent `CREATE TABLE IF NOT EXISTS` (+ index) statements that mirror
 * the parts of the editor model the DataSource needs, scoped to one workspace.
 * Returned as an ordered list so the DO can exec them on first use.
 *
 * Mirrors editor.pages (rows), editor.db_properties, editor.db_views — but
 * everything is local to this workspace's SQLite, so no workspace_id column is
 * needed. `props` uses SQLite JSON1 (json_extract / json_set / json_remove).
 */
export function buildSchemaStatements(): string[] {
  return [
    // The native database containers that live on this backend (metadata mirror;
    // the canonical tree/ACL page still lives on PG in Step 2).
    `CREATE TABLE IF NOT EXISTS databases (
       id TEXT PRIMARY KEY,
       title TEXT NOT NULL DEFAULT 'Untitled database',
       icon TEXT,
       created_at TEXT NOT NULL
     )`,
    // Column definitions.
    `CREATE TABLE IF NOT EXISTS properties (
       id TEXT PRIMARY KEY,
       database_id TEXT NOT NULL,
       name TEXT NOT NULL,
       type TEXT NOT NULL,
       config TEXT NOT NULL DEFAULT '{}',
       position INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX IF NOT EXISTS properties_db_idx ON properties(database_id, position)`,
    // Saved views.
    `CREATE TABLE IF NOT EXISTS views (
       id TEXT PRIMARY KEY,
       database_id TEXT NOT NULL,
       kind TEXT NOT NULL,
       name TEXT NOT NULL,
       config TEXT NOT NULL DEFAULT '{}',
       source_database_id TEXT,
       position INTEGER NOT NULL DEFAULT 0
     )`,
    `CREATE INDEX IF NOT EXISTS views_db_idx ON views(database_id, position)`,
    // Rows (each a page-ish record; carries the page fields the model needs).
    `CREATE TABLE IF NOT EXISTS rows (
       id TEXT PRIMARY KEY,
       database_id TEXT NOT NULL,
       title TEXT NOT NULL DEFAULT 'Untitled',
       icon TEXT,
       props TEXT NOT NULL DEFAULT '{}',
       snapshot_html TEXT NOT NULL DEFAULT '',
       sub_item_parent_id TEXT,
       is_template INTEGER NOT NULL DEFAULT 0,
       template_of TEXT,
       archived INTEGER NOT NULL DEFAULT 0,
       position INTEGER NOT NULL DEFAULT 0,
       created_at TEXT NOT NULL,
       updated_at TEXT NOT NULL,
       created_by TEXT,
       last_edited_by TEXT
     )`,
    `CREATE INDEX IF NOT EXISTS rows_db_archived_idx ON rows(database_id, archived)`,
    `CREATE INDEX IF NOT EXISTS rows_sub_item_idx ON rows(sub_item_parent_id)`,
  ];
}

/** Parse a JSON TEXT column to an object, defaulting to `{}` on any failure. */
export function parseProps(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value === '') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Map a stored row into the wire `DbRow` shape, IDENTICAL to what dbRowsImpl
 * produces from Postgres (before relations/rollups/formulas shaping). meta
 * mirrors the PG path: created_by / last_edited_by resolve to the stored user
 * id (the DO doesn't join a user directory; NativeDataSource leaves the name
 * as the id, matching PG's `ownerName || ownerId` fallback).
 */
export function rowFromStored(r: StoredRow): DbRow {
  const createdBy = r.createdBy ?? null;
  return {
    id: r.id,
    title: r.title,
    props: parseProps(r.props),
    meta: {
      createdTime: String(r.createdTime),
      lastEditedTime: String(r.lastEditedTime),
      createdById: createdBy,
      createdByName: createdBy,
    },
    subItemParentId: r.subItemParentId ?? null,
  };
}
