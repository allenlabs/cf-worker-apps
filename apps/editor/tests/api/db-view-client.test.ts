// Phase 15 unit tests for the client-side table-view helpers (web app/lib):
// sub-item tree build (with cycle/orphan safety) + grouping.

import { describe, it, expect } from 'vitest';
import {
  buildSubItemTree,
  flattenSubItems,
  groupRowsForView,
} from '~/lib/db-view';
import type { DbRow } from '~/server/docs';

const row = (id: string, over: Partial<DbRow> = {}): DbRow => ({
  id,
  title: id,
  props: {},
  meta: { createdTime: '', lastEditedTime: '', createdById: null, createdByName: null },
  subItemParentId: null,
  ...over,
});

describe('buildSubItemTree', () => {
  it('nests children under their parent', () => {
    const rows = [
      row('p'),
      row('c1', { subItemParentId: 'p' }),
      row('c2', { subItemParentId: 'p' }),
      row('g1', { subItemParentId: 'c1' }),
    ];
    const tree = buildSubItemTree(rows);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.row.id).toBe('p');
    expect(tree[0]!.children.map((c) => c.row.id)).toEqual(['c1', 'c2']);
    expect(tree[0]!.children[0]!.children[0]!.row.id).toBe('g1');
    expect(tree[0]!.children[0]!.depth).toBe(1);
    expect(tree[0]!.children[0]!.children[0]!.depth).toBe(2);
  });

  it('surfaces an orphan (parent not in the set) at the top level', () => {
    const tree = buildSubItemTree([row('c1', { subItemParentId: 'missing' })]);
    expect(tree.map((n) => n.row.id)).toEqual(['c1']);
  });

  it('is cycle-safe (a → b → a does not loop)', () => {
    const rows = [row('a', { subItemParentId: 'b' }), row('b', { subItemParentId: 'a' })];
    // Both reference an in-set parent → neither is a "root"; the visited-set
    // guard still terminates. We just assert it returns without hanging.
    const tree = buildSubItemTree(rows);
    expect(Array.isArray(tree)).toBe(true);
  });
});

describe('flattenSubItems', () => {
  it('hides children of a collapsed parent', () => {
    const rows = [row('p'), row('c1', { subItemParentId: 'p' })];
    const tree = buildSubItemTree(rows);
    const open = flattenSubItems(tree, new Set());
    expect(open.map((r) => r.row.id)).toEqual(['p', 'c1']);
    expect(open[0]!.hasChildren).toBe(true);
    const collapsed = flattenSubItems(tree, new Set(['p']));
    expect(collapsed.map((r) => r.row.id)).toEqual(['p']);
  });
});

describe('groupRowsForView', () => {
  it('groups by a select prop, null bucket last', () => {
    const rows = [
      row('a', { props: { s: 'todo' } }),
      row('b', { props: {} }),
      row('c', { props: { s: 'todo' } }),
      row('d', { props: { s: 'done' } }),
    ];
    const groups = groupRowsForView(rows, 's');
    expect(groups.map((g) => g.key)).toEqual(['todo', 'done', null]);
    expect(groups[0]!.rows.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('groups by title', () => {
    const groups = groupRowsForView([row('x'), row('y')], 'title');
    expect(groups.map((g) => g.key)).toEqual(['x', 'y']);
  });
});
