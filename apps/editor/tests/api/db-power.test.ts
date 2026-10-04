// Phase 15 unit tests for the db.ts power features: applyViewConfig, the
// sub-item cycle guard + setSubItemParent, template seed deep-copy in
// addRowImpl, the template impls, and linked-view source resolution. Drive the
// impls with a fake `Sql` tagged-template returning canned rows matched by a
// fragment of the query text (mirrors page-meta.test.ts / acl.test.ts).

import { describe, it, expect } from 'vitest';
import {
  applyViewConfig,
  subItemCycleImpl,
  setSubItemParentImpl,
  addRowImpl,
  listTemplatesImpl,
  createTemplateImpl,
  renameTemplateImpl,
  deleteTemplateImpl,
  templateDatabaseImpl,
  viewSourceDatabaseImpl,
  type DbRow,
} from '@api/handlers/db';
import type { Sql } from '@api/lib/db';

const NOW = Date.UTC(2026, 5, 2);
const mkRow = (title: string, props: Record<string, unknown> = {}): DbRow => ({
  id: title,
  title,
  props,
  meta: { createdTime: '', lastEditedTime: '', createdById: null, createdByName: null },
});

// ---------- applyViewConfig ----------

describe('applyViewConfig', () => {
  const rows = [mkRow('a', { n: 3, s: 'todo' }), mkRow('b', { n: 1, s: 'done' }), mkRow('c', { n: 2, s: 'todo' })];

  it('applies a filter group then multi-level sorts', () => {
    const out = applyViewConfig(
      rows,
      {
        filterGroup: { conjunction: 'and', conditions: [{ propId: 's', op: 'is', value: 'todo' }] },
        sorts: [{ propId: 'n', dir: 'asc' }],
      },
      NOW,
    );
    expect(out.map((r) => r.title)).toEqual(['c', 'a']);
  });

  it('honors a legacy flat filters array', () => {
    const out = applyViewConfig(rows, { filters: [{ propId: 's', op: 'contains', value: 'done' }] }, NOW);
    expect(out.map((r) => r.title)).toEqual(['b']);
  });

  it('no config → unchanged', () => {
    expect(applyViewConfig(rows, {}, NOW).map((r) => r.title)).toEqual(['a', 'b', 'c']);
  });
});

// ---------- sub-item cycle guard ----------

describe('subItemCycleImpl', () => {
  /** A chain map: id → its sub_item_parent_id. */
  function fakeSql(chain: Record<string, string | null>): Sql {
    return ((strings: TemplateStringsArray, id: string) => {
      void strings;
      return Promise.resolve([{ parentId: chain[id] ?? null }]);
    }) as unknown as Sql;
  }

  it('detects a direct cycle (parent === row)', async () => {
    expect(await subItemCycleImpl(fakeSql({}), 'r1', 'r1')).toBe(true);
  });

  it('detects an indirect cycle (row is an ancestor of the new parent)', async () => {
    // parent p2's chain climbs p2 → p1 → r1 → (root). Making r1's parent p2 cycles.
    const sql = fakeSql({ p2: 'p1', p1: 'r1', r1: null });
    expect(await subItemCycleImpl(sql, 'r1', 'p2')).toBe(true);
  });

  it('allows a non-cyclic parent', async () => {
    const sql = fakeSql({ p2: 'p1', p1: null });
    expect(await subItemCycleImpl(sql, 'r1', 'p2')).toBe(false);
  });
});

describe('setSubItemParentImpl', () => {
  it('refuses a self-parent', async () => {
    // rowDatabaseImpl returns a db, then the self check throws.
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('database_id AS')) return Promise.resolve([{ databaseId: 'db1' }]);
      return Promise.resolve([]);
    }) as unknown as Sql;
    await expect(setSubItemParentImpl(sql, 'r1', 'r1')).rejects.toThrow();
  });

  it('returns false when the row is not a database row', async () => {
    const sql = (() => Promise.resolve([{ databaseId: null }])) as unknown as Sql;
    expect(await setSubItemParentImpl(sql, 'r1', null)).toBe(false);
  });

  it('clears the parent (null) on a real row', async () => {
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('database_id AS')) return Promise.resolve([{ databaseId: 'db1' }]);
      if (text.includes('UPDATE editor.pages')) return Promise.resolve([{ id: 'r1' }]);
      return Promise.resolve([]);
    }) as unknown as Sql;
    expect(await setSubItemParentImpl(sql, 'r1', null)).toBe(true);
  });

  it('rejects a parent in a different database', async () => {
    let call = 0;
    const sql = ((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('database_id AS')) {
        call += 1;
        // First call (row) → db1; second (parent) → db2.
        return Promise.resolve([{ databaseId: call === 1 ? 'db1' : 'db2' }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    await expect(setSubItemParentImpl(sql, 'r1', 'p1')).rejects.toThrow();
  });
});

// ---------- template seed deep-copy (addRowImpl) ----------

describe('addRowImpl — template seed', () => {
  it('deep-copies the template db_props + snapshot_html into the new row', async () => {
    const tplProps = { p1: 'seed', p2: ['x', 'y'] };
    let updateProps: unknown = null;
    const sql = ((first: unknown, ...rest: unknown[]) => {
      const strings = first as unknown as TemplateStringsArray;
      const text = strings.join('?');
      // addRowImpl: workspace lookup.
      if (text.includes('workspace_id AS')) return Promise.resolve([{ workspaceId: 'ws1' }]);
      // template lookup.
      if (text.includes('template_of =') && text.includes('snapshot_html AS')) {
        return Promise.resolve([{ title: 'Bug template', props: tplProps, snapshotHtml: '<p>seed</p>' }]);
      }
      // createPageImpl: MAX(position) then INSERT ... RETURNING.
      if (text.includes('MAX(position)')) return Promise.resolve([{ maxPos: 0 }]);
      if (text.includes('INSERT INTO editor.pages')) {
        return Promise.resolve([{ id: 'new-row', title: 'Bug template', parentId: 'db1' }]);
      }
      // UPDATE that writes db_props (the seed copy).
      if (text.includes('UPDATE editor.pages') && text.includes('db_props =')) {
        // db_props value is passed via sql.json → our passthrough returns the object.
        updateProps = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r));
        return Promise.resolve([]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;

    const row = await addRowImpl(sql, 'u1', { databaseId: 'db1', templateId: 'tpl1' });
    expect(row.props).toEqual(tplProps);
    expect(updateProps).toEqual(tplProps);
    // Adopted the template's title (no explicit title supplied).
    expect(row.title).toBe('Bug template');
  });

  it('a plain add (no template) seeds empty props', async () => {
    const sql = ((first: unknown) => {
      const strings = first as unknown as TemplateStringsArray;
      const text = strings.join('?');
      if (text.includes('workspace_id AS')) return Promise.resolve([{ workspaceId: 'ws1' }]);
      if (text.includes('MAX(position)')) return Promise.resolve([{ maxPos: -1 }]);
      if (text.includes('INSERT INTO editor.pages')) {
        return Promise.resolve([{ id: 'new-row', title: 'Untitled', parentId: 'db1' }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => v;
    const row = await addRowImpl(sql, 'u1', { databaseId: 'db1' });
    expect(row.props).toEqual({});
  });
});

// ---------- template impls ----------

describe('template impls', () => {
  it('listTemplatesImpl returns id+title rows', async () => {
    const sql = (() => Promise.resolve([{ id: 't1', title: 'Bug' }, { id: 't2', title: 'Task' }])) as unknown as Sql;
    expect(await listTemplatesImpl(sql, 'db1')).toEqual([
      { id: 't1', title: 'Bug' },
      { id: 't2', title: 'Task' },
    ]);
  });

  it('createTemplateImpl creates + flags a hidden page', async () => {
    const sql = ((first: unknown) => {
      const strings = first as unknown as TemplateStringsArray;
      const text = strings.join('?');
      if (text.includes('workspace_id AS')) return Promise.resolve([{ workspaceId: 'ws1' }]);
      if (text.includes('MAX(position)')) return Promise.resolve([{ maxPos: -1 }]);
      if (text.includes('INSERT INTO editor.pages')) {
        return Promise.resolve([{ id: 'tpl1', title: 'New template', parentId: 'db1' }]);
      }
      return Promise.resolve([]);
    }) as unknown as Sql;
    const tpl = await createTemplateImpl(sql, 'u1', { databaseId: 'db1' });
    expect(tpl).toEqual({ id: 'tpl1', title: 'New template' });
  });

  it('renameTemplateImpl / deleteTemplateImpl report success by row count', async () => {
    const ok = (() => Promise.resolve([{ id: 't1' }])) as unknown as Sql;
    const miss = (() => Promise.resolve([])) as unknown as Sql;
    expect(await renameTemplateImpl(ok, 't1', 'X')).toBe(true);
    expect(await renameTemplateImpl(miss, 't1', 'X')).toBe(false);
    expect(await deleteTemplateImpl(ok, 't1')).toBe(true);
    expect(await deleteTemplateImpl(miss, 't1')).toBe(false);
  });

  it('templateDatabaseImpl resolves template_of', async () => {
    const sql = (() => Promise.resolve([{ databaseId: 'db1' }])) as unknown as Sql;
    expect(await templateDatabaseImpl(sql, 't1')).toBe('db1');
    const none = (() => Promise.resolve([])) as unknown as Sql;
    expect(await templateDatabaseImpl(none, 't1')).toBeNull();
  });
});

// ---------- linked-view source resolution ----------

describe('viewSourceDatabaseImpl', () => {
  it('returns the source DB for a linked view', async () => {
    const sql = (() => Promise.resolve([{ sourceDatabaseId: 'src-db' }])) as unknown as Sql;
    expect(await viewSourceDatabaseImpl(sql, 'v1')).toBe('src-db');
  });
  it('returns null for a normal view / missing view', async () => {
    const normal = (() => Promise.resolve([{ sourceDatabaseId: null }])) as unknown as Sql;
    expect(await viewSourceDatabaseImpl(normal, 'v1')).toBeNull();
    const missing = (() => Promise.resolve([])) as unknown as Sql;
    expect(await viewSourceDatabaseImpl(missing, 'v1')).toBeNull();
  });
});
