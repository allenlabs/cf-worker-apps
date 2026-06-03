// Native-DO create-flow integration test (Datasource Step 2 — the REAL path).
//
// This drives `NativeDataSource` (the exact class the /db/create router uses)
// against a LIVE WorkspaceDB SQLite Durable Object via
// @cloudflare/vitest-pool-workers — NOT a fake stub. It reproduces, end to end,
// what the `backend='native_do'` create handler does and what a reload + a view
// filter then read back:
//
//   1. createDatabase(seedDefaults) — provision the DO container + default
//      Table view + Status/Date starter props (the DO-side seeding the router
//      runs after createDatabaseImpl skips PG seeding).
//   2. schema() resolves the seeded view + props  → reload renders a DatabaseView.
//   3. addRow ×N + listRows() returns them        → rows resolve from the DO.
//   4. persist a filter on the seeded view via updateView(config.filterGroup),
//      then listRows(viewId) NARROWS the result  → filter round-trips DO→read.
//
// The pre-existing fake-stub tests (tests/api/native-datasource.test.ts) cannot
// catch a break here: they never touch the live DO RPC + SQLite, so a create
// path that silently failed to provision the DO (the original prod bug: zero
// native_do rows, reload renders a plain doc, filters never narrow) passed the
// fakes but failed in production. This test exercises the real wiring.

import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { NativeDataSource, type WorkspaceDBStub } from '@api/datasource/native';

const WS = 'ws-native-create-flow';
const OWNER = 'user-create-flow';

/** A NativeDataSource over the live per-workspace DO (the router's real class). */
function nativeDataSource(): NativeDataSource {
  const id = env.WORKSPACE_DB.idFromName(WS);
  const stub = env.WORKSPACE_DB.get(id) as unknown as WorkspaceDBStub;
  return new NativeDataSource(stub);
}

function dbId(label: string): string {
  return `db-${label}-${crypto.randomUUID()}`;
}

describe('native_do create flow (live DO via NativeDataSource)', () => {
  it('provisions the DO container + seeded schema so a reload resolves a DatabaseView', async () => {
    const ds = nativeDataSource();
    const id = dbId('reload');

    // Exactly what /db/create runs for backend='native_do' after the PG
    // container page is written (createDatabaseImpl skips PG seeding).
    await ds.createDatabase({ id, title: 'Native DB', seedDefaults: true });

    // hasDatabase proves the DO container actually exists (not a no-op). This
    // is exactly the post-create verification the /db/create router runs before
    // returning success — an unprovisioned id reads false (and would trigger a
    // rollback of the PG container), a provisioned one reads true.
    expect(await ds.hasDatabase(`never-${crypto.randomUUID()}`)).toBe(false);
    expect(await ds.hasDatabase(id)).toBe(true);

    // schema() is what p.$pageId.tsx loads to render <DatabaseView>; without a
    // provisioned DO it would be null and the page falls back to a plain doc.
    const schema = await ds.schema(id);
    expect(schema).not.toBeNull();
    expect(schema!.database).toEqual({ id, title: 'Native DB' });
    expect(schema!.views.map((v) => v.type)).toEqual(['table']);
    expect(schema!.properties.map((p) => p.name)).toEqual(['Status', 'Date']);
  });

  it('rows added through the native datasource read back from the DO', async () => {
    const ds = nativeDataSource();
    const id = dbId('rows');
    await ds.createDatabase({ id, title: 'Rows DB', seedDefaults: true });

    const a = await ds.createRow({ databaseId: id, ownerId: OWNER, title: 'Alpha' });
    const b = await ds.createRow({ databaseId: id, ownerId: OWNER, title: 'Beta' });
    expect(a.id).not.toBe(b.id);

    const rows = await ds.listRows({ databaseId: id });
    expect(rows.map((r) => r.title)).toEqual(['Alpha', 'Beta']);
    // rowDatabase resolves the owning DB (the native ACL/hint path the router
    // uses to route /db/row/update for a native row whose id isn't in PG).
    expect(await ds.rowDatabase(a.id)).toBe(id);
  });

  it('a persisted view filter NARROWS listRows end-to-end (DO updateView → listRows re-read)', async () => {
    const ds = nativeDataSource();
    const id = dbId('filter');
    await ds.createDatabase({ id, title: 'Filter DB', seedDefaults: true });

    // The seeded default Table view is the one the filter UI edits.
    const seededView = (await ds.listViews(id)).find((v) => v.type === 'table')!;
    expect(seededView).toBeDefined();

    await ds.createRow({ databaseId: id, ownerId: OWNER, title: 'keep-me' });
    await ds.createRow({ databaseId: id, ownerId: OWNER, title: 'drop-me' });
    await ds.createRow({ databaseId: id, ownerId: OWNER, title: 'keep-too' });

    // Unfiltered: all three rows.
    expect((await ds.listRows({ databaseId: id, viewId: seededView.id })).map((r) => r.title)).toEqual([
      'keep-me',
      'drop-me',
      'keep-too',
    ]);

    // Persist a title filter on the seeded view (exactly what /db/view/update
    // does for a native DB: NativeDataSource.updateView → DO stores config).
    const ok = await ds.updateView({
      id: seededView.id,
      config: {
        filterGroup: {
          conjunction: 'and',
          conditions: [{ propId: 'title', op: 'contains', value: 'keep' }],
        },
      },
    });
    expect(ok).toBe(true);

    // Re-reading rows for the view must NARROW to the matching titles. This is
    // the DO viewConfig → applyViewConfig path the prod E2E asserts.
    const filtered = await ds.listRows({ databaseId: id, viewId: seededView.id });
    expect(filtered.map((r) => r.title)).toEqual(['keep-me', 'keep-too']);

    // The persisted config survives a fresh datasource (no in-process cache).
    const fresh = nativeDataSource();
    const persisted = await fresh.listRows({ databaseId: id, viewId: seededView.id });
    expect(persisted.map((r) => r.title)).toEqual(['keep-me', 'keep-too']);
  });

  it('dropDatabase removes the DO data so an in-app delete leaves no orphans', async () => {
    const ds = nativeDataSource();
    const id = dbId('drop');
    await ds.createDatabase({ id, title: 'Drop DB', seedDefaults: true });
    await ds.createRow({ databaseId: id, ownerId: OWNER, title: 'row' });

    expect(await ds.hasDatabase(id)).toBe(true);
    expect(await ds.dropDatabase(id)).toBe(true);
    expect(await ds.hasDatabase(id)).toBe(false);
    expect(await ds.schema(id)).toBeNull();
    expect(await ds.listRows({ databaseId: id })).toEqual([]);
  });
});
