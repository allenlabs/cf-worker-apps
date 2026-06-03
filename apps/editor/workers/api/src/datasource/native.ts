// NativeDataSource (Datasource Step 2).
//
// A `DataSource` implementation backed by a per-workspace SQLite Durable Object
// (WorkspaceDB). This is the OPT-IN native backend for NEW databases marked
// `db_backend='native_do'`; existing Postgres databases are untouched and keep
// using PostgresDataSource.
//
// Storage/retrieval lives in the DO (workers/api/src/do/workspace-db.ts). This
// class owns the SHAPING: for listRows it pulls raw `DbRow[]` from the DO, then
// runs the SAME pure helpers the Postgres path uses —
//   applyRelationsAndRollups → resolveFormulas → applyViewConfig
// (all from handlers/db.ts) — so native results are byte-for-byte identical to
// what dbRowsImpl returns. The DO never filters/sorts/groups or resolves
// relations/rollups/formulas itself; that logic stays in one place.
//
// Relation/rollup resolution: target rows are fetched from the SAME workspace
// DO (one SQLite per workspace), so within-workspace cross-database relations
// resolve. CROSS-WORKSPACE relations are OUT OF SCOPE (a relation pointing at a
// row in another workspace's DO won't resolve — its chip is dropped, exactly as
// a dangling id is on Postgres). Documented here + in the report.

import {
  applyRelationsAndRollups,
  applyViewConfig,
  collectRelationTargetIds,
  resolveFormulas,
  type DbProperty,
  type DbRow,
  type DbSchema,
  type DbView,
  type TargetRowData,
} from '../handlers/db';
import {
  NATIVE_CAPABILITIES,
  type Capabilities,
  type CreatePropertyInput,
  type CreateRowInput,
  type CreateViewInput,
  type DataSource,
  type ListRowsInput,
  type UpdatePropertyInput,
  type UpdateRowInput,
  type UpdateViewInput,
} from './types';
import type { WorkspaceDB } from '../do/workspace-db';
import type { Env } from '../lib/env';

/**
 * The subset of WorkspaceDB RPC NativeDataSource depends on. Declared here so
 * the data source can be unit-tested with a plain fake stub in node (no DO
 * runtime), while the real `DurableObjectStub<WorkspaceDB>` satisfies it too.
 */
export interface WorkspaceDBStub {
  hasDatabase(databaseId: string): Promise<boolean>;
  createDatabase(input: {
    id: string;
    title?: string;
    icon?: string | null;
    seedDefaults?: boolean;
  }): Promise<{ id: string }>;
  dropDatabase(databaseId: string): Promise<boolean>;
  listProperties(databaseId: string): Promise<DbProperty[]>;
  listViews(databaseId: string): Promise<DbView[]>;
  schema(databaseId: string): Promise<DbSchema | null>;
  createProperty(input: {
    databaseId: string;
    name: string;
    type: string;
    config?: Record<string, unknown>;
  }): Promise<DbProperty>;
  updateProperty(input: {
    id: string;
    name?: string;
    type?: string;
    config?: Record<string, unknown>;
  }): Promise<boolean>;
  deleteProperty(id: string): Promise<boolean>;
  createView(input: {
    databaseId: string;
    type: string;
    name?: string;
    config?: Record<string, unknown>;
    sourceDatabaseId?: string | null;
  }): Promise<DbView>;
  updateView(input: {
    id: string;
    name?: string;
    config?: Record<string, unknown>;
    sourceDatabaseId?: string | null;
  }): Promise<boolean>;
  deleteView(id: string): Promise<boolean>;
  listRowsRaw(databaseId: string): Promise<DbRow[]>;
  fetchTargetRows(ids: string[]): Promise<
    {
      id: string;
      title: string;
      icon: string | null;
      props: Record<string, unknown>;
      createdTime: string;
      lastEditedTime: string;
    }[]
  >;
  createRow(input: {
    databaseId: string;
    ownerId: string;
    title?: string;
    templateId?: string | null;
    subItemParentId?: string | null;
  }): Promise<DbRow>;
  updateRow(input: {
    rowId: string;
    title?: string;
    props?: Record<string, unknown>;
    lastEditedBy?: string | null;
  }): Promise<boolean>;
  deleteRow(rowId: string): Promise<boolean>;
  viewConfig(viewId: string): Promise<Record<string, unknown> | null>;
  viewSourceDatabase(viewId: string): Promise<string | null>;
  rowDatabase(rowId: string): Promise<string | null>;
  propertyDatabase(propertyId: string): Promise<string | null>;
  viewDatabase(viewId: string): Promise<string | null>;
}

/**
 * A DataSource over a single workspace's WorkspaceDB DO. Full native
 * capabilities (DO rows carry title/icon/snapshot_html, so page bodies +
 * sub-items + relations are all supported).
 */
export class NativeDataSource implements DataSource {
  private readonly stub: WorkspaceDBStub;

  constructor(stub: WorkspaceDBStub) {
    this.stub = stub;
  }

  capabilities(_databaseId?: string): Capabilities {
    return NATIVE_CAPABILITIES;
  }

  // ----- rows -----

  async listRows(input: ListRowsInput): Promise<DbRow[]> {
    const now = input.now ?? Date.now();
    // A linked view reads the source DB's rows; the schema for shaping must
    // match the rows being read, so use the effective DB id (matches PG).
    const rowsDbId = input.sourceDatabaseId ?? input.databaseId;

    const rows = await this.stub.listRowsRaw(rowsDbId);
    const properties = await this.stub.listProperties(rowsDbId);

    // Relation/rollup: collect referenced target ids, batch-fetch them from the
    // SAME workspace DO, then run the shared pure shaping core.
    const targetIds = collectRelationTargetIds(properties, rows);
    const targets = new Map<string, TargetRowData>();
    if (targetIds.length > 0) {
      const fetched = await this.stub.fetchTargetRows(targetIds);
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
    applyRelationsAndRollups(properties, rows, targets);

    // Formulas (after relations/rollups so they can reference computed values).
    resolveFormulas(rows, properties);

    // Apply the named view's filter/sort exactly as dbRowsImpl does.
    if (!input.viewId) return rows;
    const config = (await this.stub.viewConfig(input.viewId)) ?? {};
    return applyViewConfig(rows, config, now);
  }

  async createRow(input: CreateRowInput): Promise<DbRow> {
    return this.stub.createRow({
      databaseId: input.databaseId,
      ownerId: input.ownerId,
      title: input.title,
      templateId: input.templateId ?? null,
      subItemParentId: input.subItemParentId ?? null,
    });
  }

  async updateRow(input: UpdateRowInput): Promise<boolean> {
    return this.stub.updateRow({
      rowId: input.rowId,
      title: input.title,
      props: input.props,
    });
  }

  async deleteRow(rowId: string): Promise<boolean> {
    return this.stub.deleteRow(rowId);
  }

  // ----- properties -----

  listProperties(databaseId: string): Promise<DbProperty[]> {
    return this.stub.listProperties(databaseId);
  }

  createProperty(input: CreatePropertyInput): Promise<DbProperty> {
    return this.stub.createProperty({
      databaseId: input.databaseId,
      name: input.name,
      type: input.type,
      config: input.config,
    });
  }

  updateProperty(input: UpdatePropertyInput): Promise<boolean> {
    return this.stub.updateProperty({
      id: input.id,
      name: input.name,
      type: input.type,
      config: input.config,
    });
  }

  deleteProperty(id: string): Promise<boolean> {
    return this.stub.deleteProperty(id);
  }

  // ----- views -----

  listViews(databaseId: string): Promise<DbView[]> {
    return this.stub.listViews(databaseId);
  }

  createView(input: CreateViewInput): Promise<DbView> {
    return this.stub.createView({
      databaseId: input.databaseId,
      type: input.type,
      name: input.name,
      config: input.config,
      sourceDatabaseId: input.sourceDatabaseId ?? null,
    });
  }

  updateView(input: UpdateViewInput): Promise<boolean> {
    return this.stub.updateView({
      id: input.id,
      name: input.name,
      config: input.config,
      sourceDatabaseId: input.sourceDatabaseId,
    });
  }

  deleteView(id: string): Promise<boolean> {
    return this.stub.deleteView(id);
  }

  // ----- schema -----

  schema(databaseId: string): Promise<DbSchema | null> {
    return this.stub.schema(databaseId);
  }

  // ----- native-only helpers (NOT part of the DataSource interface) -----
  //
  // The router uses these to (a) provision a native database's DO-side
  // schema on /db/create and (b) resolve a native property/view/row's owning
  // database for ACL gating, since those ids do NOT live in Postgres.

  /** Provision the DO-side container (+ default view/props) for a native DB. */
  createDatabase(input: {
    id: string;
    title?: string;
    icon?: string | null;
    seedDefaults?: boolean;
  }): Promise<{ id: string }> {
    return this.stub.createDatabase(input);
  }

  hasDatabase(databaseId: string): Promise<boolean> {
    return this.stub.hasDatabase(databaseId);
  }

  /**
   * Drop a native database's DO-side data (rows/properties/views + container).
   * Called when its PG container page is archived/purged so the DO is fully
   * cleaned up (DO rows are NOT removed by the `editor.pages` cleanup path).
   */
  dropDatabase(databaseId: string): Promise<boolean> {
    return this.stub.dropDatabase(databaseId);
  }

  rowDatabase(rowId: string): Promise<string | null> {
    return this.stub.rowDatabase(rowId);
  }

  propertyDatabase(propertyId: string): Promise<string | null> {
    return this.stub.propertyDatabase(propertyId);
  }

  viewDatabase(viewId: string): Promise<string | null> {
    return this.stub.viewDatabase(viewId);
  }

  viewSourceDatabase(viewId: string): Promise<string | null> {
    return this.stub.viewSourceDatabase(viewId);
  }
}

/** Env shape needed to resolve a workspace's WorkspaceDB stub. */
export interface NativeEnv {
  WORKSPACE_DB: DurableObjectNamespace<WorkspaceDB>;
}

/**
 * Build a NativeDataSource for a workspace. Resolves the per-workspace DO via
 * `idFromName(workspaceId)` so every workspace gets its own SQLite store.
 */
export function makeNativeDataSource(
  env: Pick<Env, never> & NativeEnv,
  workspaceId: string,
): NativeDataSource {
  const id = env.WORKSPACE_DB.idFromName(workspaceId);
  const stub = env.WORKSPACE_DB.get(id) as unknown as WorkspaceDBStub;
  return new NativeDataSource(stub);
}
