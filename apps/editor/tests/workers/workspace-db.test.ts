// WorkspaceDB integration test (Datasource Step 2 proof) — drives the SQLite
// Durable Object end-to-end through its namespace stub against REAL miniflare
// SQLite via @cloudflare/vitest-pool-workers. This is the proof that the schema
// (buildSchemaStatements) + the RPC surface (CRUD over this.ctx.storage.sql)
// actually work on a live SQLite engine, complementing the node-level
// statement-builder + shaping tests in tests/api/.
//
// Everything runs in one DO instance (one workspace). We exercise:
//   createDatabase → createProperty(s) → createRow(s) (incl. props + a sub-item)
//   → listRowsRaw (raw order + parsed props, archived excluded) → updateRow →
//   deleteRow → fetchTargetRows → views CRUD → schema → dropDatabase. NOTE:
//   templates are a PG-side feature in Step 2 (no DO RPC inserts an
//   is_template row), so the template path is asserted as a safe no-op.

import { env } from 'cloudflare:test';
import { describe, it, expect, beforeEach } from 'vitest';
import type { WorkspaceDBStub } from '@api/datasource/native';

const WS = 'ws-integration-1';
const OWNER = 'user-owner-1';

/**
 * A fresh DO stub for this workspace (one SQLite store per DO instance), typed
 * as `WorkspaceDBStub` — the exact RPC surface NativeDataSource consumes. The
 * live `DurableObjectStub<WorkspaceDB>` satisfies it structurally; typing it
 * this way keeps the method signatures (which return `DbRow[]`/`DbView[]` with
 * `Record<string, unknown>` fields) from collapsing under the Workers RPC
 * result-type machinery.
 */
function stub(): WorkspaceDBStub {
  const id = env.WORKSPACE_DB.idFromName(WS);
  return env.WORKSPACE_DB.get(id) as unknown as WorkspaceDBStub;
}

/** Unique database id per test so state never bleeds across cases. */
function dbId(label: string): string {
  return `db-${label}-${crypto.randomUUID()}`;
}

describe('WorkspaceDB (live miniflare SQLite)', () => {
  let db: WorkspaceDBStub;
  beforeEach(() => {
    db = stub();
  });

  it('createDatabase seeds defaults; hasDatabase + schema reflect them', async () => {
    const id = dbId('seed');
    await db.createDatabase({ id, title: 'My DB' });

    expect(await db.hasDatabase(id)).toBe(true);
    expect(await db.hasDatabase('nope')).toBe(false);

    const schema = await db.schema(id);
    expect(schema).not.toBeNull();
    expect(schema!.database).toEqual({ id, title: 'My DB' });
    // Seeded: a default Table view + Status (select) + Date props.
    expect(schema!.views.map((v) => v.type)).toEqual(['table']);
    expect(schema!.properties.map((p) => p.name)).toEqual(['Status', 'Date']);
    // Status carries its select options (JSON config round-trips).
    const status = schema!.properties.find((p) => p.name === 'Status')!;
    expect(status.type).toBe('select');
    expect((status.config.options as unknown[]).length).toBe(3);
  });

  it('createDatabase without seedDefaults leaves an empty schema', async () => {
    const id = dbId('bare');
    await db.createDatabase({ id, title: 'Bare', seedDefaults: false });
    const schema = await db.schema(id);
    expect(schema!.properties).toEqual([]);
    expect(schema!.views).toEqual([]);
  });

  it('property CRUD round-trips through SQLite', async () => {
    const id = dbId('props');
    await db.createDatabase({ id, title: 'Props', seedDefaults: false });

    const text = await db.createProperty({ databaseId: id, name: 'Name', type: 'text' });
    expect(text.name).toBe('Name');
    expect(text.position).toBe(0);
    const num = await db.createProperty({
      databaseId: id,
      name: 'Score',
      type: 'number',
      config: { format: 'percent' },
    });
    expect(num.position).toBe(1);
    expect(num.config).toEqual({ format: 'percent' });

    // Update name + config; both persist.
    expect(await db.updateProperty({ id: num.id, name: 'Points', config: { format: 'number' } })).toBe(true);
    const props = await db.listProperties(id);
    expect(props.map((p) => p.name)).toEqual(['Name', 'Points']);
    expect(props[1]!.config).toEqual({ format: 'number' });

    // No-op patch on an existing property still succeeds.
    expect(await db.updateProperty({ id: text.id })).toBe(true);
    expect(await db.updateProperty({ id: 'missing' })).toBe(false);

    // propertyDatabase resolves the owning DB.
    expect(await db.propertyDatabase(text.id)).toBe(id);
    expect(await db.propertyDatabase('missing')).toBeNull();

    // Delete strips the prop.
    expect(await db.deleteProperty(num.id)).toBe(true);
    expect((await db.listProperties(id)).map((p) => p.name)).toEqual(['Name']);
  });

  it('row CRUD: props round-trip, sub-items nest, listRowsRaw is ordered + archived-free', async () => {
    const id = dbId('rows');
    await db.createDatabase({ id, title: 'Rows', seedDefaults: false });
    const status = await db.createProperty({ databaseId: id, name: 'Status', type: 'text' });

    // Row 1 with props.
    const r1 = await db.createRow({ databaseId: id, ownerId: OWNER, title: 'First' });
    expect(r1.title).toBe('First');
    expect(r1.meta.createdById).toBe(OWNER);
    await db.updateRow({ rowId: r1.id, props: { [status.id]: 'Doing' }, lastEditedBy: OWNER });

    // Row 2.
    const r2 = await db.createRow({ databaseId: id, ownerId: OWNER, title: 'Second' });

    // A sub-item nested under row 1.
    const sub = await db.createRow({
      databaseId: id,
      ownerId: OWNER,
      title: 'Child',
      subItemParentId: r1.id,
    });
    expect(sub.subItemParentId).toBe(r1.id);

    const raw = await db.listRowsRaw(id);
    // Stable order by position, then created_at — insertion order here.
    expect(raw.map((r) => r.title)).toEqual(['First', 'Second', 'Child']);
    // Props parsed from JSON TEXT back into an object.
    const first = raw.find((r) => r.id === r1.id)!;
    expect(first.props).toEqual({ [status.id]: 'Doing' });
    expect(raw.find((r) => r.id === sub.id)!.subItemParentId).toBe(r1.id);

    // rowDatabase resolves the owning DB.
    expect(await db.rowDatabase(r2.id)).toBe(id);
    expect(await db.rowDatabase('missing')).toBeNull();

    // updateRow merges props (shallow) and updates the title.
    await db.updateRow({ rowId: r2.id, title: 'Second!', props: { [status.id]: 'Done' } });
    const afterUpdate = await db.listRowsRaw(id);
    const second = afterUpdate.find((r) => r.id === r2.id)!;
    expect(second.title).toBe('Second!');
    expect(second.props).toEqual({ [status.id]: 'Done' });

    // deleteRow soft-archives (excluded from listRowsRaw afterwards).
    expect(await db.deleteRow(r2.id)).toBe(true);
    expect(await db.deleteRow(r2.id)).toBe(false); // already archived
    expect((await db.listRowsRaw(id)).map((r) => r.id)).not.toContain(r2.id);
  });

  it('deleteProperty scrubs the key from every row props', async () => {
    const id = dbId('scrub');
    await db.createDatabase({ id, title: 'Scrub', seedDefaults: false });
    const p = await db.createProperty({ databaseId: id, name: 'Tag', type: 'text' });
    const r = await db.createRow({ databaseId: id, ownerId: OWNER, title: 'R' });
    await db.updateRow({ rowId: r.id, props: { [p.id]: 'keep-me' } });

    expect((await db.listRowsRaw(id))[0]!.props).toEqual({ [p.id]: 'keep-me' });
    await db.deleteProperty(p.id);
    expect((await db.listRowsRaw(id))[0]!.props).toEqual({});
  });

  it('fetchTargetRows batch-fetches rows by id (relation/rollup resolution)', async () => {
    const id = dbId('targets');
    await db.createDatabase({ id, title: 'Targets', seedDefaults: false });
    const a = await db.createRow({ databaseId: id, ownerId: OWNER, title: 'A' });
    const b = await db.createRow({ databaseId: id, ownerId: OWNER, title: 'B' });

    expect(await db.fetchTargetRows([])).toEqual([]);
    const fetched = await db.fetchTargetRows([a.id, b.id, 'missing']);
    expect(fetched.map((r) => r.title).sort()).toEqual(['A', 'B']);
  });

  it('view CRUD round-trips; viewConfig / viewSourceDatabase / viewDatabase resolve', async () => {
    const id = dbId('views');
    await db.createDatabase({ id, title: 'Views', seedDefaults: false });

    const board = await db.createView({ databaseId: id, type: 'board', config: { groupBy: 'g' } });
    expect(board.type).toBe('board');
    expect(board.name).toBe('Board');
    expect(board.position).toBe(0);

    // Unknown view kind degrades to 'table'.
    const weird = await db.createView({ databaseId: id, type: 'mystery', name: 'Weird' });
    expect(weird.type).toBe('table');

    // A linked view records its source database id.
    const linked = await db.createView({ databaseId: id, type: 'table', name: 'Linked', sourceDatabaseId: 'src-db' });
    expect(await db.viewSourceDatabase(linked.id)).toBe('src-db');
    expect(await db.viewSourceDatabase(board.id)).toBeNull();

    expect(await db.viewConfig(board.id)).toEqual({ groupBy: 'g' });
    expect(await db.viewConfig('missing')).toBeNull();
    expect(await db.viewDatabase(linked.id)).toBe(id);
    expect(await db.viewDatabase('missing')).toBeNull();

    // Update + delete.
    expect(await db.updateView({ id: board.id, name: 'Kanban', config: { groupBy: 'h' } })).toBe(true);
    expect(await db.updateView({ id: 'missing' })).toBe(false);
    const views = await db.listViews(id);
    expect(views.find((v) => v.id === board.id)!.name).toBe('Kanban');
    expect(await db.deleteView(board.id)).toBe(true);
    const afterDelete = await db.listViews(id);
    expect(afterDelete.find((v) => v.id === board.id)).toBeUndefined();
  });

  it('createRow with an unknown templateId falls back to a plain row (DO has no template RPC yet)', async () => {
    // The DO honours `templateId` only when a matching is_template=1 row exists
    // (template_of=this DB). There is no RPC to create such a template row in
    // Step 2 (templates remain a PG-side feature), so an unknown templateId is
    // a safe no-op that creates an ordinary row. This documents that contract.
    const id = dbId('tpl');
    await db.createDatabase({ id, title: 'Tpl', seedDefaults: false });
    const p = await db.createProperty({ databaseId: id, name: 'Stage', type: 'text' });

    const r = await db.createRow({
      databaseId: id,
      ownerId: OWNER,
      title: 'Plain',
      templateId: crypto.randomUUID(),
    });
    await db.updateRow({ rowId: r.id, props: { [p.id]: 'X' } });
    const listed = await db.listRowsRaw(id);
    expect(listed.map((x) => x.title)).toEqual(['Plain']);
    expect(listed[0]!.props).toEqual({ [p.id]: 'X' });
  });

  it('dropDatabase removes all rows/properties/views + the container', async () => {
    const id = dbId('drop');
    await db.createDatabase({ id, title: 'Drop', seedDefaults: true });
    await db.createRow({ databaseId: id, ownerId: OWNER, title: 'Row' });
    await db.createProperty({ databaseId: id, name: 'Extra', type: 'text' });

    expect(await db.hasDatabase(id)).toBe(true);
    const beforeDrop = await db.listRowsRaw(id);
    expect(beforeDrop.length).toBe(1);

    // Drop reports prior existence, then is a no-op.
    expect(await db.dropDatabase(id)).toBe(true);
    expect(await db.dropDatabase(id)).toBe(false);

    expect(await db.hasDatabase(id)).toBe(false);
    expect(await db.schema(id)).toBeNull();
    expect(await db.listRowsRaw(id)).toEqual([]);
    expect(await db.listProperties(id)).toEqual([]);
    expect(await db.listViews(id)).toEqual([]);
  });
});
