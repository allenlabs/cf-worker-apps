// Table-view calculation/aggregation footer (Notion parity). Pure, dependency-
// free helpers that compute an aggregation over the *currently-loaded* (already
// filter/sort-shaped) cell values for one column. The DatabaseView holds all
// rows in state, so the math runs client-side — no extra server round-trip.
//
// The chosen op per column is persisted in the active view's config under
// `config.calcs = { [propId]: op }` (via the existing `viewUpdate` server fn),
// so a reload restores the footer selections.

/** Every aggregation op we support, across all property types. */
export type AggregationOp =
  | 'none'
  // Universal (all types)
  | 'count_all'
  | 'count_empty'
  | 'count_not_empty'
  | 'count_unique'
  | 'percent_empty'
  | 'percent_not_empty'
  // number
  | 'sum'
  | 'average'
  | 'median'
  | 'min'
  | 'max'
  | 'range'
  // checkbox
  | 'checked'
  | 'unchecked'
  | 'percent_checked'
  // date
  | 'earliest'
  | 'latest'
  | 'date_range';

/** i18n key for each op's footer label. */
export const AGG_LABEL_KEY: Record<AggregationOp, string> = {
  none: 'db.calc.none',
  count_all: 'db.calc.countAll',
  count_empty: 'db.calc.countEmpty',
  count_not_empty: 'db.calc.countNotEmpty',
  count_unique: 'db.calc.countUnique',
  percent_empty: 'db.calc.percentEmpty',
  percent_not_empty: 'db.calc.percentNotEmpty',
  sum: 'db.calc.sum',
  average: 'db.calc.average',
  median: 'db.calc.median',
  min: 'db.calc.min',
  max: 'db.calc.max',
  range: 'db.calc.range',
  checked: 'db.calc.checked',
  unchecked: 'db.calc.unchecked',
  percent_checked: 'db.calc.percentChecked',
  earliest: 'db.calc.earliest',
  latest: 'db.calc.latest',
  date_range: 'db.calc.dateRange',
};

/** The universal ops every property type offers. */
const UNIVERSAL_OPS: AggregationOp[] = [
  'count_all',
  'count_empty',
  'count_not_empty',
  'count_unique',
  'percent_empty',
  'percent_not_empty',
];

/**
 * Aggregation ops available for a given property type, in menu order. The first
 * entry is always 'none' ("Calculate"); then type-specific ops, then the
 * universal set. Mirrors Notion's per-type calculation menu.
 */
export function aggOptionsForType(type: string): AggregationOp[] {
  switch (type) {
    case 'number':
    case 'rollup':
      return ['none', 'sum', 'average', 'median', 'min', 'max', 'range', ...UNIVERSAL_OPS];
    case 'checkbox':
      return ['none', 'checked', 'unchecked', 'percent_checked', ...UNIVERSAL_OPS];
    case 'date':
    case 'created_time':
    case 'last_edited_time':
      return ['none', 'earliest', 'latest', 'date_range', ...UNIVERSAL_OPS];
    default:
      // text/select/multi_select/status/person/files/url/email/phone/relation/
      // formula/title → universal only.
      return ['none', ...UNIVERSAL_OPS];
  }
}

/** Back-compat alias matching the spec's naming. */
export const AGG_OPTIONS_FOR_TYPE = aggOptionsForType;

/** True iff a cell value counts as "empty" for aggregation. */
export function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  // A formula error sentinel ({ __error }) counts as empty for math purposes.
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof obj.__error === 'string') return true;
    return Object.keys(obj).length === 0;
  }
  return false;
}

/** Coerce a cell value to a finite number, or null if it isn't numeric. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  return null;
}

/** Parse a cell value to epoch millis, or null if it isn't a valid date. */
function toDateMs(value: unknown): number | null {
  if (typeof value !== 'string' || value === '') return null;
  // Bare YYYY-MM-DD → treat as local midnight (matches calendar/timeline).
  const iso = value.length === 10 ? `${value}T00:00:00` : value;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Format a number for the footer (integers bare, else 2 decimals). */
function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '';
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function fmtPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '0%';
  return `${Math.round(ratio * 100)}%`;
}

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

/** Approx whole-day span between two epoch-ms values (for date_range). */
function dayspan(minMs: number, maxMs: number): number {
  return Math.round((maxMs - minMs) / 86_400_000);
}

export interface AggregationResult {
  /** Formatted display string for the footer cell ('' for op 'none'). */
  text: string;
}

/**
 * Compute an aggregation over a column's raw values.
 *
 * @param op     the chosen aggregation
 * @param values every (already filter/sort-shaped) row's raw value for the column
 * @param type   the property type (drives numeric/date/checkbox coercion)
 */
export function computeAggregation(
  op: AggregationOp,
  values: unknown[],
  type: string,
): AggregationResult {
  const total = values.length;
  if (op === 'none' || total === 0) {
    // count_all on an empty set is still a valid 0; only 'none' is blank.
    if (op === 'none') return { text: '' };
  }

  const nonEmpty = values.filter((v) => !isEmptyValue(v));
  const emptyCount = total - nonEmpty.length;

  switch (op) {
    case 'count_all':
      return { text: String(total) };
    case 'count_empty':
      return { text: String(emptyCount) };
    case 'count_not_empty':
      return { text: String(nonEmpty.length) };
    case 'count_unique': {
      const seen = new Set<string>();
      for (const v of nonEmpty) {
        // Arrays (multi_select/relation/files) count each member individually.
        if (Array.isArray(v)) {
          for (const m of v) seen.add(JSON.stringify(m));
        } else {
          seen.add(JSON.stringify(v));
        }
      }
      return { text: String(seen.size) };
    }
    case 'percent_empty':
      return { text: fmtPercent(total === 0 ? 0 : emptyCount / total) };
    case 'percent_not_empty':
      return { text: fmtPercent(total === 0 ? 0 : nonEmpty.length / total) };

    // ----- number -----
    case 'sum':
    case 'average':
    case 'median':
    case 'min':
    case 'max':
    case 'range': {
      const nums = values
        .map((v) => toNumber(v))
        .filter((n): n is number => n !== null);
      if (nums.length === 0) return { text: '' };
      if (op === 'sum') return { text: fmtNum(nums.reduce((a, b) => a + b, 0)) };
      if (op === 'average') return { text: fmtNum(nums.reduce((a, b) => a + b, 0) / nums.length) };
      if (op === 'median') return { text: fmtNum(median(nums)) };
      if (op === 'min') return { text: fmtNum(Math.min(...nums)) };
      if (op === 'max') return { text: fmtNum(Math.max(...nums)) };
      // range = max − min
      return { text: fmtNum(Math.max(...nums) - Math.min(...nums)) };
    }

    // ----- checkbox -----
    case 'checked':
      return { text: String(values.filter((v) => v === true).length) };
    case 'unchecked':
      return { text: String(values.filter((v) => v !== true).length) };
    case 'percent_checked':
      return { text: fmtPercent(total === 0 ? 0 : values.filter((v) => v === true).length / total) };

    // ----- date -----
    case 'earliest':
    case 'latest':
    case 'date_range': {
      const ms = values
        .map((v) => toDateMs(v))
        .filter((n): n is number => n !== null);
      if (ms.length === 0) return { text: '' };
      const min = Math.min(...ms);
      const max = Math.max(...ms);
      if (op === 'earliest') return { text: fmtDate(min) };
      if (op === 'latest') return { text: fmtDate(max) };
      // date_range → whole-day span.
      const days = dayspan(min, max);
      return { text: days === 1 ? '1 day' : `${days} days` };
    }

    default:
      return { text: '' };
  }
}
