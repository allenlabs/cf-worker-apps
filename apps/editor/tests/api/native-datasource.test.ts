// Unit tests for the Datasource Step 2 NativeDataSource (per-workspace DO
// SQLite backend) — exercised WITHOUT the workers pool via a fake DO stub that
// implements the WorkspaceDBStub RPC over in-memory maps.
//
// The point: prove NativeDataSource reuses the SAME shared pure shaping helpers
// (applyRelationsAndRollups / resolveFormulas / applyViewConfig from
// handlers/db.ts), so its listRows output matches the Postgres path exactly.
// The DO returns RAW rows; the shaping is identical-by-construction. We assert
// relation chips, rollups, formulas, filtering and sorting all match.
//
// The live DO SQLite (CRUD against this.ctx.storage.sql) needs
// @cloudflare/vitest-pool-workers; that integration path is documented as a
// manual `wrangler dev` check. The SQL statement-builders + row mapping that
// the DO relies on ARE unit-tested here (workspace-db-sql.ts).

import { describe, it, expect } from 'vitest';
import { NativeDataSource, type WorkspaceDBStub } from '@api/datasource/native';
import { NATIVE_CAPABILITIES } from '@api/datasource/types';
import {
  buildSchemaStatements,
  parseProps,
  rowFromStored,
  type StoredRow,
} from '@api/do/workspace-db-sql';
import type { DbProperty, DbRow, DbView } from '@api/handlers/db';

const DB = 'db-1';
const SRC = 'db-src';

function meta(createdTime = '2026-01-01T00:00:00.000Z') {
  return { createdTime, lastEditedTime: createdTime, createdById: 'u1', createdByName: 'u1' };
}

/**
 * A fake WorkspaceDB stub over in-memory state. Mirrors only what
 * NativeDataSource calls. Rows are stored as raw DbRow[] keyed by database id.
 */
function fakeStub(state: {
  properties?: Record<string, DbProperty[]>;
  views?: Record<string, DbView[]>;
  rows?: Record<string, DbRow[]>;
  targets?: DbRow[];
  viewConfigs?: Record<string, Record<string, unknown>>;
}): WorkspaceDBStub & { created: { id: string }[] } {
  const created: { id: string }[] = [];
  const targetIndex = new Map<string, DbRow>();
  for (const t of state.targets ?? []) targetIndex.set(t.id, t);
  return {
    created,
    async hasDatabase(id) {
      return Boolean(state.rows?.[id] || state.properties?.[id]);
    },
    async createDatabase(input) {
      created.push({ id: input.id });
      return { id: input.id };
    },
    async listProperties(id) {
      return state.properties?.[id] ?? [];
    },
    async listViews(id) {
      return state.views?.[id] ?? [];
    },
    async schema(id) {
      if (!state.properties?.[id] && !state.views?.[id]) return null;
      return {
        database: { id, title: 'Native DB' },
        properties: state.properties?.[id] ?? [],
        views: state.views?.[id] ?? [],
      };
    },
    async createProperty(input) {
      return {
        id: 'new-prop',
        databaseId: input.databaseId,
        name: input.name,
        type: input.type,
        config: input.config ?? {},
        position: 0,
      };
    },
    async updateProperty() {
      return true;
    },
    async deleteProperty() {
      return true;
    },
    async createView(input) {
      return {
        id: 'new-view',
        databaseId: input.databaseId,
        name: input.name ?? 'Table',
        type: input.type,
        config: input.config ?? {},
        position: 0,
        sourceDatabaseId: input.sourceDatabaseId ?? null,
      };
    },
    async updateView() {
      return true;
    },
    async deleteView() {
      return true;
    },
    async listRowsRaw(id) {
      // Return deep clones so shaping mutations don't leak across calls.
      return (state.rows?.[id] ?? []).map((r) => structuredClone(r));
    },
    async fetchTargetRows(ids) {
      return ids
        .map((id) => targetIndex.get(id))
        .filter((r): r is DbRow => r !== undefined)
        .map((r) => ({
          id: r.id,
          title: r.title,
          icon: null,
          props: r.props,
          createdTime: r.meta.createdTime,
          lastEditedTime: r.meta.lastEditedTime,
        }));
    },
    async createRow(input) {
      return {
        id: 'new-row',
        title: input.title ?? 'Untitled',
        props: {},
        meta: meta(),
        subItemParentId: input.subItemParentId ?? null,
      };
    },
    async updateRow() {
      return true;
    },
    async deleteRow() {
      return true;
    },
    async viewConfig(viewId) {
      return state.viewConfigs?.[viewId] ?? null;
    },
    async viewSourceDatabase() {
      return null;
    },
    async rowDatabase() {
      return null;
    },
    async propertyDatabase() {
      return null;
    },
    async viewDatabase() {
      return null;
    },
  };
}

describe('NativeDataSource capabilities', () => {
  it('reports the full native capability set (writable, page bodies, relations)', () => {
    const ds = new NativeDataSource(fakeStub({}));
    expect(ds.capabilities()).toEqual(NATIVE_CAPABILITIES);
    expect(ds.capabilities().readOnly).toBe(false);
    expect(ds.capabilities().supportsPageBody).toBe(true);
    expect(ds.capabilities().supportsRelations).toBe(true);
    expect(ds.capabilities(DB).canCreateRow).toBe(true);
  });
});

describe('NativeDataSource listRows shaping (matches the Postgres path)', () => {
  it('resolves relation chips from target rows fetched out of the SAME DO', async () => {
    const props: DbProperty[] = [
      { id: 'rel', databaseId: DB, name: 'Related', type: 'relation', config: {}, position: 0 },
    ];
    const rows: DbRow[] = [
      { id: 'r1', title: 'Row 1', props: { rel: ['t1', 't2', 'gone'] }, meta: meta() },
    ];
    const targets: DbRow[] = [
      { id: 't1', title: 'Target One', props: {}, meta: meta() },
      { id: 't2', title: 'Target Two', props: {}, meta: meta() },
    ];
    const ds = new NativeDataSource(
      fakeStub({ properties: { [DB]: props }, rows: { [DB]: rows }, targets }),
    );
    const out = await ds.listRows({ databaseId: DB });
    expect(out).toHaveLength(1);
    // Dangling id 'gone' is dropped; resolved chips carry title + icon.
    expect(out[0]!.relations?.rel).toEqual([
      { id: 't1', title: 'Target One', icon: null },
      { id: 't2', title: 'Target Two', icon: null },
    ]);
  });

  it('computes a rollup (sum) over the related rows\' numeric prop', async () => {
    const props: DbProperty[] = [
      { id: 'rel', databaseId: DB, name: 'Related', type: 'relation', config: {}, position: 0 },
      {
        id: 'roll',
        databaseId: DB,
        name: 'Total',
        type: 'rollup',
        config: { relationPropId: 'rel', targetPropId: 'amount', fn: 'sum' },
        position: 1,
      },
    ];
    const rows: DbRow[] = [
      { id: 'r1', title: 'Row 1', props: { rel: ['t1', 't2'] }, meta: meta() },
    ];
    const targets: DbRow[] = [
      { id: 't1', title: 'T1', props: { amount: 10 }, meta: meta() },
      { id: 't2', title: 'T2', props: { amount: 5 }, meta: meta() },
    ];
    const ds = new NativeDataSource(
      fakeStub({ properties: { [DB]: props }, rows: { [DB]: rows }, targets }),
    );
    const out = await ds.listRows({ databaseId: DB });
    expect(out[0]!.rollups?.roll).toBe(15);
  });

  it('evaluates a formula property referencing another column by name', async () => {
    const props: DbProperty[] = [
      { id: 'qty', databaseId: DB, name: 'Qty', type: 'number', config: {}, position: 0 },
      { id: 'price', databaseId: DB, name: 'Price', type: 'number', config: {}, position: 1 },
      {
        id: 'total',
        databaseId: DB,
        name: 'Total',
        type: 'formula',
        config: { expression: 'prop("Qty") * prop("Price")' },
        position: 2,
      },
    ];
    const rows: DbRow[] = [
      { id: 'r1', title: 'Row 1', props: { qty: 3, price: 4 }, meta: meta() },
    ];
    const ds = new NativeDataSource(fakeStub({ properties: { [DB]: props }, rows: { [DB]: rows } }));
    const out = await ds.listRows({ databaseId: DB });
    expect(out[0]!.formulas?.total).toBe(12);
  });

  it('applies the named view\'s filter + sort config (from the DO)', async () => {
    const props: DbProperty[] = [
      { id: 'status', databaseId: DB, name: 'Status', type: 'select', config: {}, position: 0 },
      { id: 'n', databaseId: DB, name: 'N', type: 'number', config: {}, position: 1 },
    ];
    const rows: DbRow[] = [
      { id: 'r1', title: 'A', props: { status: 'done', n: 2 }, meta: meta() },
      { id: 'r2', title: 'B', props: { status: 'todo', n: 9 }, meta: meta() },
      { id: 'r3', title: 'C', props: { status: 'done', n: 1 }, meta: meta() },
    ];
    const viewConfigs = {
      v1: {
        filterGroup: { conjunction: 'and', conditions: [{ propId: 'status', op: 'is', value: 'done' }] },
        sorts: [{ propId: 'n', dir: 'asc' }],
      },
    };
    const ds = new NativeDataSource(
      fakeStub({ properties: { [DB]: props }, rows: { [DB]: rows }, viewConfigs }),
    );
    const out = await ds.listRows({ databaseId: DB, viewId: 'v1' });
    // Filter keeps the two 'done' rows; sort by n asc → r3 (1) then r1 (2).
    expect(out.map((r) => r.id)).toEqual(['r3', 'r1']);
  });

  it('a linked view reads the SOURCE database\'s rows + schema', async () => {
    const srcProps: DbProperty[] = [
      { id: 's', databaseId: SRC, name: 'S', type: 'text', config: {}, position: 0 },
    ];
    const srcRows: DbRow[] = [{ id: 'sr1', title: 'Src Row', props: { s: 'x' }, meta: meta() }];
    const ds = new NativeDataSource(
      fakeStub({ properties: { [SRC]: srcProps }, rows: { [SRC]: srcRows } }),
    );
    const out = await ds.listRows({ databaseId: DB, sourceDatabaseId: SRC });
    expect(out.map((r) => r.id)).toEqual(['sr1']);
  });

  it('without a viewId returns all rows unshaped-by-config (raw order)', async () => {
    const rows: DbRow[] = [
      { id: 'r1', title: 'A', props: {}, meta: meta() },
      { id: 'r2', title: 'B', props: {}, meta: meta() },
    ];
    const ds = new NativeDataSource(fakeStub({ properties: { [DB]: [] }, rows: { [DB]: rows } }));
    const out = await ds.listRows({ databaseId: DB });
    expect(out.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

describe('NativeDataSource CRUD delegation', () => {
  it('createRow / updateRow / deleteRow + schema CRUD pass through to the stub', async () => {
    const ds = new NativeDataSource(fakeStub({ properties: { [DB]: [] }, views: { [DB]: [] } }));
    const row = await ds.createRow({ databaseId: DB, ownerId: 'u1', title: 'Hi' });
    expect(row.id).toBe('new-row');
    expect(row.title).toBe('Hi');
    expect(await ds.updateRow({ rowId: 'new-row', props: { a: 1 } })).toBe(true);
    expect(await ds.deleteRow('new-row')).toBe(true);

    const prop = await ds.createProperty({ databaseId: DB, name: 'X', type: 'text' });
    expect(prop.id).toBe('new-prop');
    expect(await ds.updateProperty({ id: 'new-prop', name: 'Y' })).toBe(true);
    expect(await ds.deleteProperty('new-prop')).toBe(true);

    const view = await ds.createView({ databaseId: DB, type: 'board' });
    expect(view.id).toBe('new-view');
    expect(await ds.updateView({ id: 'new-view', name: 'Z' })).toBe(true);
    expect(await ds.deleteView('new-view')).toBe(true);

    const schema = await ds.schema(DB);
    expect(schema?.database.id).toBe(DB);
  });

  it('createDatabase provisions the DO container', async () => {
    const stub = fakeStub({});
    const ds = new NativeDataSource(stub);
    await ds.createDatabase({ id: DB, title: 'New', seedDefaults: true });
    expect(stub.created).toEqual([{ id: DB }]);
  });
});

describe('WorkspaceDB SQL builders (workspace-db-sql.ts — pure, node-testable)', () => {
  it('buildSchemaStatements emits idempotent CREATE TABLE IF NOT EXISTS for every table', () => {
    const stmts = buildSchemaStatements();
    const joined = stmts.join('\n');
    for (const t of ['databases', 'properties', 'views', 'rows']) {
      expect(joined).toContain(`CREATE TABLE IF NOT EXISTS ${t}`);
    }
    // Every statement is idempotent (CREATE ... IF NOT EXISTS).
    for (const s of stmts) expect(s).toMatch(/CREATE (TABLE|INDEX) IF NOT EXISTS/);
    // The rows table carries the page-ish fields the model needs.
    expect(joined).toContain('snapshot_html');
    expect(joined).toContain('sub_item_parent_id');
    expect(joined).toContain('is_template');
    // Indices on (database_id, archived) and sub_item_parent_id.
    expect(joined).toContain('rows(database_id, archived)');
    expect(joined).toContain('rows(sub_item_parent_id)');
  });

  it('parseProps defaults to {} for null / invalid / non-object JSON', () => {
    expect(parseProps('{"a":1}')).toEqual({ a: 1 });
    expect(parseProps('')).toEqual({});
    expect(parseProps(null)).toEqual({});
    expect(parseProps('not json')).toEqual({});
    expect(parseProps('[1,2]')).toEqual({});
    expect(parseProps('42')).toEqual({});
  });

  it('rowFromStored maps a stored row into the wire DbRow shape (matches PG)', () => {
    const stored: StoredRow = {
      id: 'r1',
      title: 'Row',
      icon: null,
      props: '{"a":1}',
      subItemParentId: 'parent-1',
      createdTime: '2026-01-01T00:00:00.000Z',
      lastEditedTime: '2026-01-02T00:00:00.000Z',
      createdBy: 'user-1',
      lastEditedBy: 'user-2',
    };
    const row = rowFromStored(stored);
    expect(row).toEqual<DbRow>({
      id: 'r1',
      title: 'Row',
      props: { a: 1 },
      meta: {
        createdTime: '2026-01-01T00:00:00.000Z',
        lastEditedTime: '2026-01-02T00:00:00.000Z',
        createdById: 'user-1',
        // Matches the PG fallback (`ownerName || ownerId`): name == id here.
        createdByName: 'user-1',
      },
      subItemParentId: 'parent-1',
    });
  });
});
