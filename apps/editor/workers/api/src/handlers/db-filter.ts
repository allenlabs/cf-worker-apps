// Phase 15: the filter / sort / group evaluation engine for database views.
//
// Pure, dependency-free functions over already-fetched `DbRow`s so they're
// trivially unit-testable (no SQL). The server evaluates these app-side because
// row props live in a jsonb map keyed by property id — keeping it correct in TS
// beats clever SQL.
//
// Filter model (persisted on db_views.config.filterGroup, with a legacy
// fall-back to the old flat `filters` array):
//   FilterGroup = { conjunction: 'and'|'or', conditions: FilterCondition[] }
//   FilterCondition = { propId, op, value? }  OR a nested FilterGroup (one level
//                     of grouping is supported — a condition may itself be a
//                     group).
//
// Operators are typed per property kind; `evalCondition` dispatches on `op`.

// ---------- shapes ----------

export type Conjunction = 'and' | 'or';

export type FilterOp =
  // text / url / email / phone
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'is_empty'
  | 'is_not_empty'
  // number
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  // select / status / person
  | 'is'
  | 'is_not'
  // multi_select / relation
  | 'has'
  | 'has_not'
  // checkbox
  | 'checked'
  | 'unchecked'
  // date
  | 'before'
  | 'after'
  | 'on'
  | 'within_days';

export interface FilterCondition {
  propId: string;
  op: FilterOp;
  value?: unknown;
}

export interface FilterGroup {
  conjunction: Conjunction;
  // A child may be a leaf condition OR a nested group (one level of grouping).
  conditions: (FilterCondition | FilterGroup)[];
}

export interface SortSpec {
  propId: string;
  dir?: 'asc' | 'desc';
}

/** The minimal row shape the evaluator reads (title + props + a now anchor). */
export interface EvalRow {
  title: string;
  props: Record<string, unknown>;
}

/** Read a row's value for a propId; the implicit title column uses 'title'. */
export function readCell(row: EvalRow, propId: string): unknown {
  if (propId === 'title') return row.title;
  return row.props[propId] ?? null;
}

/** True iff `node` is a nested group rather than a leaf condition. */
export function isGroup(node: FilterCondition | FilterGroup): node is FilterGroup {
  return (node as FilterGroup).conditions !== undefined;
}

const EMPTY = (v: unknown): boolean =>
  v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);

function asNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asTime(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null;
  const t = new Date(v.length === 10 ? `${v}T00:00:00` : v).getTime();
  return Number.isNaN(t) ? null : t;
}

function asArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)) : [];
}

/**
 * Evaluate ONE leaf condition against a row. `now` (epoch ms) anchors the
 * relative `within_days` operator so it's deterministic + testable.
 */
export function evalCondition(row: EvalRow, cond: FilterCondition, now: number): boolean {
  const cell = readCell(row, cond.propId);
  switch (cond.op) {
    case 'is_empty':
      return EMPTY(cell);
    case 'is_not_empty':
      return !EMPTY(cell);
    case 'checked':
      return cell === true;
    case 'unchecked':
      return cell !== true;
    case 'contains':
      return String(cell ?? '').toLowerCase().includes(String(cond.value ?? '').toLowerCase());
    case 'not_contains':
      return !String(cell ?? '').toLowerCase().includes(String(cond.value ?? '').toLowerCase());
    case 'equals':
      return String(cell ?? '') === String(cond.value ?? '');
    case 'not_equals':
      return String(cell ?? '') !== String(cond.value ?? '');
    case 'is':
      return String(cell ?? '') === String(cond.value ?? '');
    case 'is_not':
      return String(cell ?? '') !== String(cond.value ?? '');
    case 'has':
      return asArray(cell).includes(String(cond.value ?? ''));
    case 'has_not':
      return !asArray(cell).includes(String(cond.value ?? ''));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(cell);
      const b = asNumber(cond.value);
      if (a === null || b === null) return false;
      return cond.op === 'gt' ? a > b : cond.op === 'gte' ? a >= b : cond.op === 'lt' ? a < b : a <= b;
    }
    case 'before':
    case 'after':
    case 'on': {
      const a = asTime(cell);
      const b = asTime(cond.value);
      if (a === null || b === null) return false;
      return cond.op === 'before' ? a < b : cond.op === 'after' ? a > b : a === b;
    }
    case 'within_days': {
      const a = asTime(cell);
      const days = asNumber(cond.value);
      if (a === null || days === null) return false;
      const delta = a - now;
      // Within the next `days` days (future-leaning, matching Notion's "within").
      return delta >= -86_400_000 && delta <= days * 86_400_000;
    }
    default:
      return true;
  }
}

/** Evaluate a (possibly nested) filter group against a row. */
export function evalGroup(row: EvalRow, group: FilterGroup, now: number): boolean {
  const children = group.conditions ?? [];
  if (children.length === 0) return true;
  const results = children.map((child) =>
    isGroup(child) ? evalGroup(row, child, now) : evalCondition(row, child, now),
  );
  return group.conjunction === 'or' ? results.some(Boolean) : results.every(Boolean);
}

/** Filter a list of rows by a group (returns a new array; stable order). */
export function applyFilterGroup<T extends EvalRow>(rows: T[], group: FilterGroup, now: number): T[] {
  return rows.filter((r) => evalGroup(r, group, now));
}

// ---------- sort ----------

/** Compare two cell values; null/empty sort last. */
export function compareValues(a: unknown, b: unknown): number {
  const an = a === null || a === undefined || a === '';
  const bn = b === null || b === undefined || b === '';
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

/** Multi-level stable sort by an ordered list of {propId,dir} specs. */
export function applySorts<T extends EvalRow>(rows: T[], sorts: SortSpec[]): T[] {
  if (!sorts.length) return rows;
  return [...rows].sort((ra, rb) => {
    for (const s of sorts) {
      const cmp = compareValues(readCell(ra, s.propId), readCell(rb, s.propId));
      if (cmp !== 0) return s.dir === 'desc' ? -cmp : cmp;
    }
    return 0;
  });
}

// ---------- group ----------

export interface RowGroup<T> {
  /** Group key (the raw cell value coerced to a string), or null for "no value". */
  key: string | null;
  rows: T[];
}

/**
 * Group rows by a property. Multi-value cells (arrays) place a row into EACH of
 * its value buckets; an empty/absent value lands in the trailing null bucket.
 * Order: first-seen value order, then the null bucket last.
 */
export function groupRows<T extends EvalRow>(rows: T[], propId: string): RowGroup<T>[] {
  const order: (string | null)[] = [];
  const buckets = new Map<string | null, T[]>();
  const push = (key: string | null, row: T) => {
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(row);
  };
  for (const row of rows) {
    const cell = readCell(row, propId);
    if (Array.isArray(cell)) {
      if (cell.length === 0) push(null, row);
      else for (const v of cell) push(String(v), row);
    } else if (EMPTY(cell)) {
      push(null, row);
    } else {
      push(String(cell), row);
    }
  }
  // Keep the null ("no value") bucket last for a tidy UI.
  order.sort((a, b) => (a === null ? 1 : b === null ? -1 : 0));
  return order.map((key) => ({ key, rows: buckets.get(key)! }));
}

// ---------- view-config normalization ----------

/**
 * Normalize a stored view config into a FilterGroup. Supports the new
 * `filterGroup` shape AND the legacy flat `filters: [{propId,value}]` array
 * (treated as an AND of `contains`/`is` style equality clauses — matching the
 * old passesFilter semantics) so existing saved views keep working.
 */
export function normalizeFilterGroup(config: {
  filterGroup?: unknown;
  filters?: { propId: string; op?: string; value?: unknown }[];
}): FilterGroup | null {
  const fg = config.filterGroup;
  if (fg && typeof fg === 'object' && Array.isArray((fg as FilterGroup).conditions)) {
    const g = fg as FilterGroup;
    return { conjunction: g.conjunction === 'or' ? 'or' : 'and', conditions: g.conditions };
  }
  const legacy = config.filters;
  if (Array.isArray(legacy) && legacy.length > 0) {
    const conditions: FilterCondition[] = legacy
      .filter((c) => c && typeof c.propId === 'string')
      .map((c) => ({
        propId: c.propId,
        op: (c.op as FilterOp) ?? 'contains',
        value: c.value,
      }));
    if (conditions.length > 0) return { conjunction: 'and', conditions };
  }
  return null;
}
