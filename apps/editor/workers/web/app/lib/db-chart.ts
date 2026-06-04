// Chart-view aggregation (Phase 18). Pure, dependency-free helpers that turn the
// *currently-loaded* (already filter/sort-shaped) rows held in DatabaseView
// state into a chart series — labels + one numeric value per label — with no
// extra server round-trip. The chart VIEW is read-only over `dbRows`, so this
// module never touches a datasource; it only reshapes rows the component
// already has.
//
// Bucketing reuses the same property-grouping approach as the board/table
// grouping (select/status options, checkbox true/false, person, and a
// value-bucket for everything else; an empty cell lands in a trailing "empty"
// bucket). Each bucket's measure is computed with `computeAggregation` from
// `db-aggregate.ts` so count / sum / average / min / max share the exact same
// emptiness + numeric-coercion rules as the table footer.
//
// The chart config is persisted in the active view's `config` jsonb (via the
// existing `viewUpdate` server fn with the `databaseId` hint) under
// `config.chart`, so a reload restores the chart-type / group-by / measure
// selections.

import { computeAggregation, type AggregationOp } from '~/lib/db-aggregate';
import type { DbProperty, DbRow } from '~/server/docs';

// ---------- config model (persisted under view.config.chart) ----------

export type ChartType = 'bar' | 'line' | 'pie' | 'donut' | 'kpi';

/** A chart measure: row count, or a number-style aggregation of one property. */
export type ChartMeasure =
  | { kind: 'count' }
  | { kind: 'sum' | 'average' | 'min' | 'max'; propId: string };

export interface ChartConfig {
  chartType: ChartType;
  /** Group-by property id (X axis / pie slices). 'title' = implicit name col.
   *  Omitted for a KPI (single number over all rows). */
  groupBy?: string;
  measure: ChartMeasure;
  /** Optional KPI caption shown under the big number. */
  kpiLabel?: string;
}

/** The default config seeded when a chart view is first created. */
export const DEFAULT_CHART_CONFIG: ChartConfig = {
  chartType: 'bar',
  measure: { kind: 'count' },
};

/** Chart types selectable in the config bar, in menu order. */
export const CHART_TYPES: ChartType[] = ['bar', 'line', 'pie', 'donut', 'kpi'];

/** Measure kinds selectable in the config bar, in menu order. */
export const MEASURE_KINDS: ChartMeasure['kind'][] = ['count', 'sum', 'average', 'min', 'max'];

/** Map a measure kind to the matching db-aggregate op (count → count_all). */
function measureOp(kind: ChartMeasure['kind']): AggregationOp {
  return kind === 'count' ? 'count_all' : kind;
}

/**
 * Coerce a persisted (untyped jsonb) `view.config.chart` into a valid
 * ChartConfig, falling back to the default for missing/invalid fields. Keeps the
 * renderer total — a malformed stored config never throws.
 */
export function normalizeChartConfig(raw: unknown): ChartConfig {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const chartType = CHART_TYPES.includes(cfg.chartType as ChartType)
    ? (cfg.chartType as ChartType)
    : DEFAULT_CHART_CONFIG.chartType;
  const groupBy = typeof cfg.groupBy === 'string' && cfg.groupBy !== '' ? cfg.groupBy : undefined;
  const kpiLabel = typeof cfg.kpiLabel === 'string' ? cfg.kpiLabel : undefined;

  const m = (cfg.measure && typeof cfg.measure === 'object' ? cfg.measure : {}) as Record<string, unknown>;
  let measure: ChartMeasure;
  if (m.kind === 'sum' || m.kind === 'average' || m.kind === 'min' || m.kind === 'max') {
    measure =
      typeof m.propId === 'string' && m.propId !== ''
        ? { kind: m.kind, propId: m.propId }
        : { kind: 'count' };
  } else {
    measure = { kind: 'count' };
  }

  return { chartType, groupBy, measure, kpiLabel };
}

// ---------- raw cell reads (mirror DatabaseView.calcValueFor) ----------

/**
 * Raw value of a row's cell for chart math. Relation/rollup/formula read from
 * their resolved side-maps; the implicit 'title' column reads row.title;
 * everything else from props. Kept raw (not display-formatted) so numeric
 * coercion in db-aggregate sees real values.
 */
export function chartCellValue(row: DbRow, property: DbProperty): unknown {
  if (property.type === 'relation') return row.relations?.[property.id] ?? [];
  if (property.type === 'rollup') return row.rollups?.[property.id] ?? null;
  if (property.type === 'formula') return row.formulas?.[property.id] ?? null;
  return row.props[property.id] ?? null;
}

// ---------- bucketing ----------

/** A group bucket: a display key (null = the empty bucket) + its rows. */
export interface ChartBucket {
  /** Stable bucket key — option id / 'true' / 'false' / raw value, or null. */
  key: string | null;
  /** Human-readable label for the axis / legend. */
  label: string;
  rows: DbRow[];
}

/** True iff a group-by cell value counts as empty for bucketing. */
function isEmptyGroupValue(value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

/**
 * Bucket rows by a group-by property, reusing the board/table grouping approach:
 *   • select / status  → one bucket per option (by option id), labelled by name
 *   • checkbox         → 'true' / 'false' buckets
 *   • multi_select / relation → one bucket per first member (single-bucket per
 *                        row, matching the table grouping rule)
 *   • everything else  → bucket by string value
 * An empty cell always lands in a trailing null bucket labelled `emptyLabel`.
 *
 * Buckets appear in first-seen order (select/status seed in option order so the
 * legend matches the schema), with the empty bucket always last and only kept
 * when non-empty.
 */
export function bucketRows(
  rows: DbRow[],
  property: DbProperty,
  emptyLabel: string,
): ChartBucket[] {
  const order: (string | null)[] = [];
  const buckets = new Map<string | null, { label: string; rows: DbRow[] }>();
  const options = property.config.options ?? [];

  const labelFor = (key: string): string => {
    if (property.type === 'select' || property.type === 'status' || property.type === 'multi_select') {
      return options.find((o) => o.id === key)?.name ?? key;
    }
    if (property.type === 'checkbox') return key === 'true' ? '✓' : '—';
    return key;
  };

  const ensure = (key: string | null): { label: string; rows: DbRow[] } => {
    let b = buckets.get(key);
    if (!b) {
      b = { label: key === null ? emptyLabel : labelFor(key), rows: [] };
      buckets.set(key, b);
      order.push(key);
    }
    return b;
  };

  // Seed select/status buckets in option order so empty options still show.
  if (property.type === 'select' || property.type === 'status') {
    for (const o of options) ensure(o.id);
  } else if (property.type === 'checkbox') {
    ensure('true');
    ensure('false');
  }

  for (const row of rows) {
    const v = chartCellValue(row, property);
    let key: string | null;
    if (property.type === 'checkbox') {
      key = v === true ? 'true' : 'false';
    } else if (isEmptyGroupValue(v)) {
      key = null;
    } else if (Array.isArray(v)) {
      // multi_select holds ids; relation holds resolved chips → bucket by first.
      const first = v[0] as unknown;
      key =
        first && typeof first === 'object'
          ? String((first as { id?: unknown }).id ?? '')
          : String(first);
      // relation chip label: prefer its title.
      if (property.type === 'relation' && first && typeof first === 'object') {
        const chip = first as { id?: string; title?: string };
        const b = ensure(chip.id ?? key);
        if (chip.title) b.label = chip.title;
        b.rows.push(row);
        continue;
      }
    } else {
      key = String(v);
    }
    ensure(key).rows.push(row);
  }

  // Empty bucket always last; drop it when it never collected a row.
  order.sort((a, b) => (a === null ? 1 : b === null ? -1 : 0));
  return order
    .map((key) => ({ key, label: buckets.get(key)!.label, rows: buckets.get(key)!.rows }))
    .filter((bkt) => bkt.key !== null || bkt.rows.length > 0);
}

// ---------- measure ----------

/**
 * Compute a chart measure over a set of rows, returning a finite number.
 * `count` → row count. `sum/average/min/max` → that aggregation of the measure
 * property's raw values (via db-aggregate, which shares the table-footer rules).
 * An empty aggregation (no numeric values) yields 0 so a bar/slice still has a
 * defined height.
 */
export function measureValue(
  rows: DbRow[],
  measure: ChartMeasure,
  properties: DbProperty[],
): number {
  if (measure.kind === 'count') return rows.length;
  const prop = properties.find((p) => p.id === measure.propId);
  if (!prop) return 0;
  const values = rows.map((r) => chartCellValue(r, prop));
  const { text } = computeAggregation(measureOp(measure.kind), values, prop.type);
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

// ---------- series ----------

export interface ChartSlice {
  label: string;
  value: number;
  /** Share of the total (0..1); 0 when total is 0. */
  fraction: number;
}

export interface ChartSeries {
  labels: string[];
  values: number[];
  slices: ChartSlice[];
  /** Sum of all bucket values (used for KPI + pie percentages). */
  total: number;
  /** Largest bucket value (used to scale bar/line axes); 0 when empty. */
  max: number;
  /** Human label of the measure (e.g. "Count", "Sum of Price"). */
  measureLabel: string;
}

/** Read a property's display name (the implicit title col is "Name"). */
function propName(properties: DbProperty[], propId: string, titleLabel: string): string {
  if (propId === 'title') return titleLabel;
  return properties.find((p) => p.id === propId)?.name ?? propId;
}

export interface BuildSeriesLabels {
  /** Label for the trailing empty bucket (e.g. "No Status" / "Empty"). */
  empty: string;
  /** Display name of the implicit title column ("Name"). */
  title: string;
  /** "Count" label for the count measure. */
  count: string;
  /** Templated measure labels keyed by kind: e.g. "Sum of {prop}". */
  sum: string;
  average: string;
  min: string;
  max: string;
}

/** Build the measure's human label ("Count" or "Sum of Price"). */
function buildMeasureLabel(
  measure: ChartMeasure,
  properties: DbProperty[],
  labels: BuildSeriesLabels,
): string {
  if (measure.kind === 'count') return labels.count;
  const name = propName(properties, measure.propId, labels.title);
  return labels[measure.kind].replace('{prop}', name);
}

/**
 * Build a chart series from the loaded rows. The single entry point the
 * ChartView renders from.
 *
 * KPI (no groupBy): one slice — the measure over ALL rows — labelled by the
 * measure name. Otherwise: bucket rows by the groupBy property, compute the
 * measure per bucket, and return parallel labels/values + per-slice fractions.
 */
export function buildChartSeries(
  rows: DbRow[],
  properties: DbProperty[],
  config: ChartConfig,
  labels: BuildSeriesLabels,
): ChartSeries {
  const measureLabel = buildMeasureLabel(config.measure, properties, labels);

  // KPI (and any chart with no group-by) → a single aggregate over all rows.
  if (config.chartType === 'kpi' || !config.groupBy) {
    const value = measureValue(rows, config.measure, properties);
    return {
      labels: [config.kpiLabel?.trim() || measureLabel],
      values: [value],
      slices: [{ label: config.kpiLabel?.trim() || measureLabel, value, fraction: 1 }],
      total: value,
      max: value,
      measureLabel,
    };
  }

  const prop = properties.find((p) => p.id === config.groupBy);
  // Implicit title column → bucket by raw title; otherwise need a real prop.
  const groupProp: DbProperty =
    prop ??
    ({ id: 'title', databaseId: '', name: labels.title, type: 'title', config: {}, position: -1 } as DbProperty);
  // For the title column, read row.title via a synthetic prop reader.
  const buckets =
    config.groupBy === 'title'
      ? bucketTitle(rows, labels.empty)
      : prop
        ? bucketRows(rows, groupProp, labels.empty)
        : [];

  const seriesLabels: string[] = [];
  const values: number[] = [];
  for (const b of buckets) {
    seriesLabels.push(b.label);
    values.push(measureValue(b.rows, config.measure, properties));
  }
  const total = values.reduce((a, b) => a + b, 0);
  const max = values.length ? Math.max(...values, 0) : 0;
  const slices: ChartSlice[] = seriesLabels.map((label, i) => ({
    label,
    value: values[i]!,
    fraction: total > 0 ? values[i]! / total : 0,
  }));

  return { labels: seriesLabels, values, slices, total, max, measureLabel };
}

/** Bucket rows by their raw title string (the implicit name column). */
function bucketTitle(rows: DbRow[], emptyLabel: string): ChartBucket[] {
  const order: (string | null)[] = [];
  const buckets = new Map<string | null, DbRow[]>();
  for (const row of rows) {
    const key = row.title && row.title.trim() !== '' ? row.title : null;
    if (!buckets.has(key)) {
      buckets.set(key, []);
      order.push(key);
    }
    buckets.get(key)!.push(row);
  }
  order.sort((a, b) => (a === null ? 1 : b === null ? -1 : 0));
  return order.map((key) => ({
    key,
    label: key === null ? emptyLabel : key,
    rows: buckets.get(key)!,
  }));
}

// ---------- formatting + palette (shared with the SVG renderer) ----------

/** Format a measure value for axis ticks / tooltips / KPI (integers bare). */
export function formatChartValue(n: number): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

/**
 * A categorical color palette (Tailwind-ish hues) that reads on both light and
 * dark backgrounds. Cycled by slice index so any number of buckets gets a
 * stable color. Pure (returns hex) so the SVG renderer stays dependency-free.
 */
export const CHART_PALETTE: string[] = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#14b8a6', // teal
  '#f97316', // orange
  '#6366f1', // indigo
  '#84cc16', // lime
];

/** Stable color for slice index `i`, cycling the palette. */
export function chartColor(i: number): string {
  const len = CHART_PALETTE.length;
  return CHART_PALETTE[((i % len) + len) % len]!;
}

/** Property types that can serve as a measure (sum/avg/min/max over numbers). */
export function isMeasurableProp(property: DbProperty): boolean {
  return property.type === 'number' || property.type === 'rollup' || property.type === 'formula';
}

/** Property types that make sensible group-by buckets (X axis / slices). */
export function isGroupableProp(property: DbProperty): boolean {
  return (
    property.type === 'select' ||
    property.type === 'status' ||
    property.type === 'checkbox' ||
    property.type === 'person' ||
    property.type === 'multi_select' ||
    property.type === 'relation' ||
    property.type === 'text' ||
    property.type === 'number' ||
    property.type === 'date'
  );
}
