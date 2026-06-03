// WorkspaceDB — a per-workspace SQLite Durable Object (Datasource Step 2).
//
// One DO instance per workspace (addressed by `idFromName(workspaceId)`), so
// each workspace gets its own ≤10GB SQLite store, unlimited workspaces, no
// static per-tenant binding. This DO is the storage backend for NATIVE
// databases only — the opt-in `db_backend='native_do'` alternative. Existing
// Postgres-backed databases never touch this code path.
//
// SCOPE (Step 2): the DO owns a native database's PROPERTIES, VIEWS and ROWS.
// It deliberately does NOT do any filtering / sorting / grouping / relation /
// rollup / formula shaping — it returns raw `DbRow[]` (+ raw target rows) and
// lets `NativeDataSource` run the SAME pure helpers the Postgres path uses
// (resolveFormulas / applyRelationsAndRollups / applyViewConfig in handlers/
// db.ts). That keeps behavior identical across backends.
//
// A native database's lightweight container/metadata page still lives on PG
// (so the sidebar tree / ACL / search keep working unchanged); only the
// rows/properties/views are redirected here. The full page/tree/ACL
// re-platform + PG→DO backfill is Step 3.

import { DurableObject } from 'cloudflare:workers';
import {
  buildSchemaStatements,
  rowFromStored,
  type StoredRow,
  type CreateDatabaseRpc,
  type CreatePropertyRpc,
  type UpdatePropertyRpc,
  type CreateViewRpc,
  type UpdateViewRpc,
  type CreateRowRpc,
  type UpdateRowRpc,
} from './workspace-db-sql';
import type {
  DbProperty,
  DbView,
  DbSchema,
  DbRow,
} from '../handlers/db';

/** A raw target row, as the relation/rollup shaping core needs it. */
export interface NativeTargetRow {
  id: string;
  title: string;
  icon: string | null;
  props: Record<string, unknown>;
  createdTime: string;
  lastEditedTime: string;
}

/** JSON.parse a TEXT column that holds a JSON object, defaulting to `{}`. */
function parseConfig(value: unknown): Record<string, unknown> {
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
 * The SQLite-backed per-workspace store. The RPC surface mirrors exactly what
 * `NativeDataSource` needs — rows/properties/views CRUD + schema + a batched
 * target-row fetch for relation/rollup resolution — and nothing more.
 */
export class WorkspaceDB extends DurableObject<unknown> {
  private initialized = false;

  /** Idempotent schema bootstrap; runs once per isolate before any access. */
  private ensureSchema(): void {
    if (this.initialized) return;
    for (const stmt of buildSchemaStatements()) {
      this.ctx.storage.sql.exec(stmt);
    }
    this.initialized = true;
  }

  private now(): string {
    return new Date().toISOString();
  }

  // ---------- databases (native container metadata mirror) ----------

  /**
   * Register a native database container in this workspace's DO. The canonical
   * tree/ACL page still lives on PG; this row exists so the DO can answer
   * `schema()` (title) + seed default property/view, and own the rows.
   */
  async createDatabase(input: CreateDatabaseRpc): Promise<{ id: string }> {
    this.ensureSchema();
    const ts = this.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO databases (id, title, icon, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, icon = excluded.icon`,
      input.id,
      input.title ?? 'Untitled database',
      input.icon ?? null,
      ts,
    );
    // Seed a default Table view + two starter props (parity with createDatabaseImpl).
    if (input.seedDefaults !== false) {
      this.ctx.storage.sql.exec(
        `INSERT INTO views (id, database_id, kind, name, config, source_database_id, position)
         VALUES (?, ?, 'table', 'Table', '{}', NULL, 0)`,
        crypto.randomUUID(),
        input.id,
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO properties (id, database_id, name, type, config, position)
         VALUES (?, ?, 'Status', 'select', ?, 0)`,
        crypto.randomUUID(),
        input.id,
        JSON.stringify({
          options: [
            { id: 'todo', name: 'To-do', color: 'gray' },
            { id: 'doing', name: 'Doing', color: 'blue' },
            { id: 'done', name: 'Done', color: 'green' },
          ],
        }),
      );
      this.ctx.storage.sql.exec(
        `INSERT INTO properties (id, database_id, name, type, config, position)
         VALUES (?, ?, 'Date', 'date', '{}', 1)`,
        crypto.randomUUID(),
        input.id,
      );
    }
    return { id: input.id };
  }

  /** True iff a native database with this id exists in this DO. */
  async hasDatabase(databaseId: string): Promise<boolean> {
    this.ensureSchema();
    const cursor = this.ctx.storage.sql.exec(
      `SELECT 1 AS one FROM databases WHERE id = ? LIMIT 1`,
      databaseId,
    );
    return cursor.toArray().length > 0;
  }

  // ---------- schema ----------

  async listProperties(databaseId: string): Promise<DbProperty[]> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, database_id AS databaseId, name, type, config, position
         FROM properties WHERE database_id = ? ORDER BY position ASC, name ASC`,
        databaseId,
      )
      .toArray() as unknown as {
      id: string;
      databaseId: string;
      name: string;
      type: string;
      config: string;
      position: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      databaseId: r.databaseId,
      name: r.name,
      type: r.type,
      config: parseConfig(r.config),
      position: Number(r.position),
    }));
  }

  async listViews(databaseId: string): Promise<DbView[]> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, database_id AS databaseId, kind, name, config,
                source_database_id AS sourceDatabaseId, position
         FROM views WHERE database_id = ? ORDER BY position ASC, name ASC`,
        databaseId,
      )
      .toArray() as unknown as {
      id: string;
      databaseId: string;
      kind: string;
      name: string;
      config: string;
      sourceDatabaseId: string | null;
      position: number;
    }[];
    return rows.map((r) => ({
      id: r.id,
      databaseId: r.databaseId,
      name: r.name,
      type: r.kind,
      config: parseConfig(r.config),
      position: Number(r.position),
      sourceDatabaseId: r.sourceDatabaseId ?? null,
    }));
  }

  async schema(databaseId: string): Promise<DbSchema | null> {
    this.ensureSchema();
    const [db] = this.ctx.storage.sql
      .exec(`SELECT id, title FROM databases WHERE id = ? LIMIT 1`, databaseId)
      .toArray() as unknown as { id: string; title: string }[];
    if (!db) return null;
    const properties = await this.listProperties(databaseId);
    const views = await this.listViews(databaseId);
    return { database: { id: db.id, title: db.title }, properties, views };
  }

  // ---------- properties CRUD ----------

  async createProperty(input: CreatePropertyRpc): Promise<DbProperty> {
    this.ensureSchema();
    const [maxRow] = this.ctx.storage.sql
      .exec(
        `SELECT MAX(position) AS maxPos FROM properties WHERE database_id = ?`,
        input.databaseId,
      )
      .toArray() as unknown as { maxPos: number | null }[];
    const position = Number(maxRow?.maxPos ?? -1) + 1;
    const id = crypto.randomUUID();
    const name = input.name.trim() || 'Property';
    const config = JSON.stringify(input.config ?? {});
    this.ctx.storage.sql.exec(
      `INSERT INTO properties (id, database_id, name, type, config, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      input.databaseId,
      name,
      input.type,
      config,
      position,
    );
    return {
      id,
      databaseId: input.databaseId,
      name,
      type: input.type,
      config: input.config ?? {},
      position,
    };
  }

  async updateProperty(input: UpdatePropertyRpc): Promise<boolean> {
    this.ensureSchema();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof input.name === 'string') {
      sets.push('name = ?');
      params.push(input.name.trim() || 'Property');
    }
    if (typeof input.type === 'string') {
      sets.push('type = ?');
      params.push(input.type);
    }
    if (input.config !== undefined) {
      sets.push('config = ?');
      params.push(JSON.stringify(input.config));
    }
    if (sets.length === 0) {
      // No-op patch: succeed iff the property exists.
      const cur = this.ctx.storage.sql.exec(
        `SELECT 1 AS one FROM properties WHERE id = ? LIMIT 1`,
        input.id,
      );
      return cur.toArray().length > 0;
    }
    params.push(input.id);
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE properties SET ${sets.join(', ')} WHERE id = ?`,
      ...params,
    );
    return cursor.rowsWritten > 0;
  }

  async deleteProperty(id: string): Promise<boolean> {
    this.ensureSchema();
    // Resolve the owning database to strip the prop from every row's props.
    const [owner] = this.ctx.storage.sql
      .exec(`SELECT database_id AS databaseId FROM properties WHERE id = ? LIMIT 1`, id)
      .toArray() as unknown as { databaseId: string }[];
    if (owner) {
      // JSON1 json_remove drops the key from each row's props (best-effort).
      this.ctx.storage.sql.exec(
        `UPDATE rows SET props = json_remove(props, '$.' || ?), updated_at = ?
         WHERE database_id = ? AND json_extract(props, '$.' || ?) IS NOT NULL`,
        id,
        this.now(),
        owner.databaseId,
        id,
      );
    }
    const cursor = this.ctx.storage.sql.exec(`DELETE FROM properties WHERE id = ?`, id);
    return cursor.rowsWritten > 0;
  }

  // ---------- views CRUD ----------

  async createView(input: CreateViewRpc): Promise<DbView> {
    this.ensureSchema();
    const [maxRow] = this.ctx.storage.sql
      .exec(`SELECT MAX(position) AS maxPos FROM views WHERE database_id = ?`, input.databaseId)
      .toArray() as unknown as { maxPos: number | null }[];
    const position = Number(maxRow?.maxPos ?? -1) + 1;
    const KNOWN = new Set(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']);
    const kind = KNOWN.has(input.type) ? input.type : 'table';
    const DEFAULT_NAMES: Record<string, string> = {
      table: 'Table',
      board: 'Board',
      list: 'List',
      gallery: 'Gallery',
      calendar: 'Calendar',
      timeline: 'Timeline',
    };
    const name = input.name?.trim() || DEFAULT_NAMES[kind] || 'View';
    const id = crypto.randomUUID();
    const config = JSON.stringify(input.config ?? {});
    this.ctx.storage.sql.exec(
      `INSERT INTO views (id, database_id, kind, name, config, source_database_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.databaseId,
      kind,
      name,
      config,
      input.sourceDatabaseId ?? null,
      position,
    );
    return {
      id,
      databaseId: input.databaseId,
      name,
      type: kind,
      config: input.config ?? {},
      position,
      sourceDatabaseId: input.sourceDatabaseId ?? null,
    };
  }

  async updateView(input: UpdateViewRpc): Promise<boolean> {
    this.ensureSchema();
    const sets: string[] = [];
    const params: unknown[] = [];
    if (typeof input.name === 'string') {
      sets.push('name = ?');
      params.push(input.name.trim() || 'View');
    }
    if (input.config !== undefined) {
      sets.push('config = ?');
      params.push(JSON.stringify(input.config));
    }
    if (input.sourceDatabaseId !== undefined) {
      sets.push('source_database_id = ?');
      params.push(input.sourceDatabaseId);
    }
    if (sets.length === 0) {
      const cur = this.ctx.storage.sql.exec(
        `SELECT 1 AS one FROM views WHERE id = ? LIMIT 1`,
        input.id,
      );
      return cur.toArray().length > 0;
    }
    params.push(input.id);
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE views SET ${sets.join(', ')} WHERE id = ?`,
      ...params,
    );
    return cursor.rowsWritten > 0;
  }

  async deleteView(id: string): Promise<boolean> {
    this.ensureSchema();
    const cursor = this.ctx.storage.sql.exec(`DELETE FROM views WHERE id = ?`, id);
    return cursor.rowsWritten > 0;
  }

  // ---------- view config lookup (for listRows) ----------

  /** Return a view's stored config (parsed) by id, or null when not found. */
  async viewConfig(viewId: string): Promise<Record<string, unknown> | null> {
    this.ensureSchema();
    const [row] = this.ctx.storage.sql
      .exec(`SELECT config FROM views WHERE id = ? LIMIT 1`, viewId)
      .toArray() as unknown as { config: string }[];
    if (!row) return null;
    return parseConfig(row.config);
  }

  /** Return a view's source database id (null = own DB / not found). */
  async viewSourceDatabase(viewId: string): Promise<string | null> {
    this.ensureSchema();
    const [row] = this.ctx.storage.sql
      .exec(`SELECT source_database_id AS src FROM views WHERE id = ? LIMIT 1`, viewId)
      .toArray() as unknown as { src: string | null }[];
    return row?.src ?? null;
  }

  // ---------- rows ----------

  /**
   * Raw (unshaped) non-archived, non-template rows of a database, in stable
   * order. The caller (NativeDataSource) runs the shared shaping helpers.
   */
  async listRowsRaw(databaseId: string): Promise<DbRow[]> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, title, icon, props,
                sub_item_parent_id AS subItemParentId,
                created_at AS createdTime, updated_at AS lastEditedTime,
                created_by AS createdBy, last_edited_by AS lastEditedBy
         FROM rows
         WHERE database_id = ? AND archived = 0 AND is_template = 0
         ORDER BY position ASC, created_at ASC`,
        databaseId,
      )
      .toArray() as unknown as StoredRow[];
    return rows.map((r) => rowFromStored(r));
  }

  /**
   * Batched fetch of target rows (across this workspace's DO) by id, for
   * relation/rollup resolution. Mirrors the Postgres batched query — within one
   * workspace all related databases live in the same DO.
   */
  async fetchTargetRows(ids: string[]): Promise<NativeTargetRow[]> {
    this.ensureSchema();
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, title, icon, props,
                created_at AS createdTime, updated_at AS lastEditedTime
         FROM rows WHERE id IN (${placeholders}) AND archived = 0`,
        ...ids,
      )
      .toArray() as unknown as {
      id: string;
      title: string;
      icon: string | null;
      props: string;
      createdTime: string;
      lastEditedTime: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      icon: r.icon ?? null,
      props: parseConfig(r.props),
      createdTime: String(r.createdTime),
      lastEditedTime: String(r.lastEditedTime),
    }));
  }

  async createRow(input: CreateRowRpc): Promise<DbRow> {
    this.ensureSchema();
    // Resolve a template (if any) belonging to this DB for the seed copy.
    let seedProps: Record<string, unknown> = {};
    let seedHtml = '';
    let seedTitle = input.title?.trim() || 'Untitled';
    if (input.templateId) {
      const [tpl] = this.ctx.storage.sql
        .exec(
          `SELECT title, props, snapshot_html AS snapshotHtml FROM rows
           WHERE id = ? AND template_of = ? AND is_template = 1 AND archived = 0 LIMIT 1`,
          input.templateId,
          input.databaseId,
        )
        .toArray() as unknown as {
        title: string;
        props: string;
        snapshotHtml: string | null;
      }[];
      if (tpl) {
        seedProps = parseConfig(tpl.props);
        seedHtml = tpl.snapshotHtml ?? '';
        if (!input.title?.trim()) seedTitle = tpl.title?.trim() || 'Untitled';
      }
    }
    const id = crypto.randomUUID();
    const ts = this.now();
    const [maxRow] = this.ctx.storage.sql
      .exec(`SELECT MAX(position) AS maxPos FROM rows WHERE database_id = ?`, input.databaseId)
      .toArray() as unknown as { maxPos: number | null }[];
    const position = Number(maxRow?.maxPos ?? -1) + 1;
    this.ctx.storage.sql.exec(
      `INSERT INTO rows
         (id, database_id, title, icon, props, snapshot_html, sub_item_parent_id,
          is_template, template_of, archived, position, created_at, updated_at,
          created_by, last_edited_by)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 0, NULL, 0, ?, ?, ?, ?, ?)`,
      id,
      input.databaseId,
      seedTitle,
      JSON.stringify(seedProps),
      seedHtml,
      input.subItemParentId ?? null,
      position,
      ts,
      ts,
      input.ownerId,
      input.ownerId,
    );
    return {
      id,
      title: seedTitle,
      props: seedProps,
      meta: {
        createdTime: ts,
        lastEditedTime: ts,
        createdById: input.ownerId,
        createdByName: null,
      },
      subItemParentId: input.subItemParentId ?? null,
    };
  }

  async updateRow(input: UpdateRowRpc): Promise<boolean> {
    this.ensureSchema();
    let touched = false;
    const ts = this.now();
    if (typeof input.title === 'string') {
      const cursor = this.ctx.storage.sql.exec(
        `UPDATE rows SET title = ?, updated_at = ?, last_edited_by = ?
         WHERE id = ? AND archived = 0`,
        input.title.trim() || 'Untitled',
        ts,
        input.lastEditedBy ?? null,
        input.rowId,
      );
      if (cursor.rowsWritten > 0) touched = true;
    }
    if (input.props !== undefined) {
      // Shallow-merge each patch key into the props JSON via json_set.
      const [before] = this.ctx.storage.sql
        .exec(`SELECT props FROM rows WHERE id = ? AND archived = 0 LIMIT 1`, input.rowId)
        .toArray() as unknown as { props: string }[];
      if (before) {
        const merged = { ...parseConfig(before.props), ...input.props };
        const cursor = this.ctx.storage.sql.exec(
          `UPDATE rows SET props = ?, updated_at = ?, last_edited_by = ?
           WHERE id = ? AND archived = 0`,
          JSON.stringify(merged),
          ts,
          input.lastEditedBy ?? null,
          input.rowId,
        );
        if (cursor.rowsWritten > 0) touched = true;
      }
    }
    if (!touched && input.title === undefined && input.props === undefined) {
      const cur = this.ctx.storage.sql.exec(
        `SELECT 1 AS one FROM rows WHERE id = ? AND archived = 0 LIMIT 1`,
        input.rowId,
      );
      return cur.toArray().length > 0;
    }
    return touched;
  }

  async deleteRow(rowId: string): Promise<boolean> {
    this.ensureSchema();
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE rows SET archived = 1, updated_at = ? WHERE id = ? AND archived = 0`,
      this.now(),
      rowId,
    );
    return cursor.rowsWritten > 0;
  }

  /** Resolve the database a row belongs to (null when not a row in this DO). */
  async rowDatabase(rowId: string): Promise<string | null> {
    this.ensureSchema();
    const [row] = this.ctx.storage.sql
      .exec(`SELECT database_id AS databaseId FROM rows WHERE id = ? LIMIT 1`, rowId)
      .toArray() as unknown as { databaseId: string }[];
    return row?.databaseId ?? null;
  }

  /** Resolve the database a property belongs to (null when not in this DO). */
  async propertyDatabase(propertyId: string): Promise<string | null> {
    this.ensureSchema();
    const [row] = this.ctx.storage.sql
      .exec(`SELECT database_id AS databaseId FROM properties WHERE id = ? LIMIT 1`, propertyId)
      .toArray() as unknown as { databaseId: string }[];
    return row?.databaseId ?? null;
  }

  /** Resolve the database a view belongs to (null when not in this DO). */
  async viewDatabase(viewId: string): Promise<string | null> {
    this.ensureSchema();
    const [row] = this.ctx.storage.sql
      .exec(`SELECT database_id AS databaseId FROM views WHERE id = ? LIMIT 1`, viewId)
      .toArray() as unknown as { databaseId: string }[];
    return row?.databaseId ?? null;
  }
}
