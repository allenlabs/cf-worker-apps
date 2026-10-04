// PostgresDataSource (Datasource Step 1).
//
// A `DataSource` implementation backed by a postgres.js `Sql` client. Every
// method is a THIN delegation to the existing pure `*Impl(sql, …)` handlers in
// handlers/db.ts — no SQL is rewritten here, so the native databases behave
// EXACTLY as before. The class just bundles the per-request `Sql` + a capability
// profile behind the `DataSource` contract so the routes (and Step 2's DO-SQLite
// NativeDataSource) can be backend-agnostic.
//
// Construction:
//   makePostgresDataSource(sql)             — our INTERNAL DB (full native caps).
//   makeExternalPostgresDataSource(config)  — a user-supplied EXTERNAL Postgres
//                                             (read-leaning; SSRF-guarded).

import postgres from 'postgres';
import type { Sql } from '../lib/db';
import { isSafePostgresConnectionString } from '../lib/host-guard';
import {
  addPropertyImpl,
  addRowImpl,
  addViewImpl,
  dbRowsImpl,
  dbSchemaImpl,
  deletePropertyImpl,
  deleteRowImpl,
  deleteViewImpl,
  listPropertiesImpl,
  listViewsImpl,
  updatePropertyImpl,
  updateRowImpl,
  updateViewImpl,
} from '../handlers/db';
import {
  type Capabilities,
  type CreatePropertyInput,
  type CreateRowInput,
  type CreateViewInput,
  type DataSource,
  type DbProperty,
  type DbRow,
  type DbSchema,
  type DbView,
  type ListRowsInput,
  type UpdatePropertyInput,
  type UpdateRowInput,
  type UpdateViewInput,
  EXTERNAL_READONLY_CAPABILITIES,
  NATIVE_CAPABILITIES,
} from './types';

/** Config for an EXTERNAL, user-owned Postgres connection. */
export interface ExternalPostgresConfig {
  /** A postgres:// connection string to the user's database. */
  connectionString: string;
  /** When true (default), the source is read-only; mutations are refused. */
  readOnly?: boolean;
  /** Optional schema search_path (defaults to `public`). */
  schema?: string;
  /** Cap on rows returned by a single listRows (default 1000). */
  maxRows?: number;
  /** Statement timeout in ms for the connection (default 5000). */
  statementTimeoutMs?: number;
}

/**
 * A DataSource over a postgres.js `Sql` client. `caps` is fixed at construction
 * (full native, or external read-only) and returned verbatim by `capabilities`.
 * When `caps.readOnly`, the mutation methods throw rather than touch the DB.
 */
export class PostgresDataSource implements DataSource {
  readonly sql: Sql;
  private readonly caps: Capabilities;

  constructor(sql: Sql, caps: Capabilities = NATIVE_CAPABILITIES) {
    this.sql = sql;
    this.caps = caps;
  }

  capabilities(_databaseId?: string): Capabilities {
    return this.caps;
  }

  private assertWritable(op: string): void {
    if (this.caps.readOnly) {
      throw new Error(`PostgresDataSource: ${op} not permitted on a read-only source`);
    }
  }

  // ----- rows -----

  listRows(input: ListRowsInput): Promise<DbRow[]> {
    return dbRowsImpl(this.sql, input.databaseId, {
      viewId: input.viewId,
      sourceDatabaseId: input.sourceDatabaseId ?? null,
      now: input.now,
    });
  }

  async createRow(input: CreateRowInput): Promise<DbRow> {
    this.assertWritable('createRow');
    return addRowImpl(this.sql, input.ownerId, {
      databaseId: input.databaseId,
      title: input.title,
      templateId: input.templateId ?? null,
      subItemParentId: input.subItemParentId ?? null,
    });
  }

  async updateRow(input: UpdateRowInput): Promise<boolean> {
    this.assertWritable('updateRow');
    return updateRowImpl(this.sql, input.rowId, {
      title: input.title,
      props: input.props,
    });
  }

  async deleteRow(rowId: string): Promise<boolean> {
    this.assertWritable('deleteRow');
    return deleteRowImpl(this.sql, rowId);
  }

  // ----- properties -----

  listProperties(databaseId: string): Promise<DbProperty[]> {
    return listPropertiesImpl(this.sql, databaseId);
  }

  async createProperty(input: CreatePropertyInput): Promise<DbProperty> {
    this.assertWritable('createProperty');
    return addPropertyImpl(this.sql, {
      databaseId: input.databaseId,
      name: input.name,
      type: input.type,
      config: input.config,
    });
  }

  async updateProperty(input: UpdatePropertyInput): Promise<boolean> {
    this.assertWritable('updateProperty');
    return updatePropertyImpl(this.sql, input.id, {
      name: input.name,
      type: input.type,
      config: input.config,
    });
  }

  async deleteProperty(id: string): Promise<boolean> {
    this.assertWritable('deleteProperty');
    return deletePropertyImpl(this.sql, id);
  }

  // ----- views -----

  listViews(databaseId: string): Promise<DbView[]> {
    return listViewsImpl(this.sql, databaseId);
  }

  async createView(input: CreateViewInput): Promise<DbView> {
    this.assertWritable('createView');
    return addViewImpl(this.sql, {
      databaseId: input.databaseId,
      type: input.type,
      name: input.name,
      config: input.config,
      sourceDatabaseId: input.sourceDatabaseId ?? null,
    });
  }

  async updateView(input: UpdateViewInput): Promise<boolean> {
    this.assertWritable('updateView');
    return updateViewImpl(this.sql, input.id, {
      name: input.name,
      config: input.config,
      sourceDatabaseId: input.sourceDatabaseId,
    });
  }

  async deleteView(id: string): Promise<boolean> {
    this.assertWritable('deleteView');
    return deleteViewImpl(this.sql, id);
  }

  // ----- schema -----

  schema(databaseId: string): Promise<DbSchema | null> {
    return dbSchemaImpl(this.sql, databaseId);
  }
}

/**
 * Build a PostgresDataSource over our INTERNAL editor database. Takes the
 * already-constructed per-request `Sql` (from `makeDb(env)` in lib/db.ts) so the
 * Hyperdrive pool + search_path stay exactly as today. Full native capabilities.
 */
export function makePostgresDataSource(sql: Sql): PostgresDataSource {
  return new PostgresDataSource(sql, NATIVE_CAPABILITIES);
}

/**
 * Build a PostgresDataSource over an EXTERNAL, user-supplied Postgres.
 *
 * Step-1 scope:
 *   - SSRF guard: refuses loopback / private / metadata connection targets
 *     (reuses the shared host guard) BEFORE opening a socket.
 *   - Read-only by default: `caps.readOnly` makes every mutation method throw,
 *     and we set `default_transaction_read_only` on the connection so even a
 *     leaked write SQL is rejected by the server.
 *   - Bounded: a statement timeout + a small pool cap the blast radius.
 *
 * NOTE (descope): table INTROSPECTION (mapping information_schema tables into
 * read-only "databases"/properties/views) is NOT implemented in Step 1 — it's a
 * documented TODO below. The point of Step 1 is the interface + internal
 * conformance; the external variant is a typed, safely-constructed seam. The row
 * impls in handlers/db.ts assume our `editor.pages` schema, so calling listRows
 * etc. against an arbitrary external schema will not work until introspection +
 * a schema-mapping layer land in a later step.
 *
 * TODO(datasource-external): introspect information_schema.tables / .columns to
 * synthesize DbSchema (one "database" per table, columns → DbProperty), and a
 * generic row reader that SELECTs from the mapped table with LIMIT maxRows. Until
 * then, the schema/row methods inherited from PostgresDataSource target the
 * `editor.*` model and should not be called on an external source.
 */
export function makeExternalPostgresDataSource(
  config: ExternalPostgresConfig,
): PostgresDataSource {
  if (!isSafePostgresConnectionString(config.connectionString)) {
    throw new Error(
      'makeExternalPostgresDataSource: refusing unsafe / internal connection target',
    );
  }
  const readOnly = config.readOnly !== false; // default true
  const statementTimeout = config.statementTimeoutMs ?? 5000;
  const sql = postgres(config.connectionString, {
    max: 2,
    fetch_types: false,
    prepare: false,
    idle_timeout: 5,
    connection: {
      search_path: config.schema ?? 'public',
      statement_timeout: statementTimeout,
      // Server-enforced read-only: a leaked write is rejected by Postgres even
      // if the JS guard is bypassed.
      default_transaction_read_only: readOnly,
    },
  });
  const caps = readOnly ? EXTERNAL_READONLY_CAPABILITIES : NATIVE_CAPABILITIES;
  return new PostgresDataSource(sql, caps);
}
