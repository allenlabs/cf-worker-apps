// Phase 15: pure client-side helpers for the table view's grouping + sub-item
// (hierarchical row) nesting. Kept dependency-free so they're unit-testable.

import type { DbRow } from '~/server/docs';

export interface RowGroup {
  /** Group key (raw cell value as string) or null for the "no value" bucket. */
  key: string | null;
  rows: DbRow[];
}

/** Read a row's value for a propId; the implicit title column uses 'title'. */
function cell(row: DbRow, propId: string): unknown {
  if (propId === 'title') return row.title;
  return row.props[propId] ?? null;
}

/**
 * Group rows by a property for the table view. Single-value cells bucket by
 * value; an empty value lands in the trailing null bucket. (Multi-value cells
 * place the row into its first value's bucket here — the table renders one row
 * per record, unlike the board.) First-seen order, null bucket last.
 */
export function groupRowsForView(rows: DbRow[], propId: string): RowGroup[] {
  const order: (string | null)[] = [];
  const buckets = new Map<string | null, DbRow[]>();
  const push = (key: string | null, row: DbRow) => {
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(row);
  };
  for (const row of rows) {
    const v = cell(row, propId);
    if (Array.isArray(v)) {
      push(v.length ? String(v[0]) : null, row);
    } else if (v === null || v === undefined || v === '') {
      push(null, row);
    } else {
      push(String(v), row);
    }
  }
  order.sort((a, b) => (a === null ? 1 : b === null ? -1 : 0));
  return order.map((key) => ({ key, rows: buckets.get(key)! }));
}

/** A row plus its nested sub-item children (for indented table rendering). */
export interface SubItemNode {
  row: DbRow;
  depth: number;
  children: SubItemNode[];
}

/**
 * Build a forest of sub-item trees from a flat row list using each row's
 * `subItemParentId`. Top-level rows are those whose parent is null OR whose
 * parent isn't in the visible set (orphans surface at the top so they're never
 * lost). Cycle-safe via a visited set + depth cap.
 */
export function buildSubItemTree(rows: DbRow[]): SubItemNode[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const childrenOf = new Map<string, DbRow[]>();
  const roots: DbRow[] = [];
  for (const row of rows) {
    const parentId = row.subItemParentId ?? null;
    if (parentId && byId.has(parentId)) {
      const list = childrenOf.get(parentId) ?? [];
      list.push(row);
      childrenOf.set(parentId, list);
    } else {
      roots.push(row);
    }
  }
  const visited = new Set<string>();
  const build = (row: DbRow, depth: number): SubItemNode => {
    visited.add(row.id);
    const kids = depth < 50 ? childrenOf.get(row.id) ?? [] : [];
    return {
      row,
      depth,
      children: kids.filter((k) => !visited.has(k.id)).map((k) => build(k, depth + 1)),
    };
  };
  return roots.map((r) => build(r, 0));
}

/** Flatten a sub-item forest into rows the table renders, honoring collapse. */
export function flattenSubItems(
  nodes: SubItemNode[],
  collapsed: Set<string>,
): { row: DbRow; depth: number; hasChildren: boolean }[] {
  const out: { row: DbRow; depth: number; hasChildren: boolean }[] = [];
  const walk = (node: SubItemNode) => {
    const hasChildren = node.children.length > 0;
    out.push({ row: node.row, depth: node.depth, hasChildren });
    if (hasChildren && !collapsed.has(node.row.id)) node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return out;
}
