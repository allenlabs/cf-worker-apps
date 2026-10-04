// Unit tests for the chart-view aggregation (web app/lib/db-chart). Pure,
// client-side reshaping of the already-loaded rows into a chart series:
// bucketing per property type, each measure (count/sum/avg/min/max), empty
// buckets, pie fractions, KPI single-value, and config normalization.

import { describe, it, expect } from 'vitest';
import {
  buildChartSeries,
  bucketRows,
  measureValue,
  normalizeChartConfig,
  chartCellValue,
  formatChartValue,
  chartColor,
  isMeasurableProp,
  isGroupableProp,
  CHART_TYPES,
  MEASURE_KINDS,
  DEFAULT_CHART_CONFIG,
  CHART_PALETTE,
  type ChartConfig,
  type BuildSeriesLabels,
} from '~/lib/db-chart';
import type { DbProperty, DbRow } from '~/server/docs';

const row = (id: string, over: Partial<DbRow> = {}): DbRow => ({
  id,
  title: id,
  props: {},
  meta: { createdTime: '', lastEditedTime: '', createdById: null, createdByName: null },
  subItemParentId: null,
  ...over,
});

const prop = (id: string, type: string, over: Partial<DbProperty> = {}): DbProperty => ({
  id,
  databaseId: 'db',
  name: id,
  type,
  config: {},
  position: 0,
  ...over,
});

const LABELS: BuildSeriesLabels = {
  empty: 'Empty',
  title: 'Name',
  count: 'Count',
  sum: 'Sum of {prop}',
  average: 'Average of {prop}',
  min: 'Min of {prop}',
  max: 'Max of {prop}',
};

const statusProp = prop('s', 'status', {
  name: 'Status',
  config: {
    options: [
      { id: 'todo', name: 'To do' },
      { id: 'done', name: 'Done' },
    ],
  },
});

describe('normalizeChartConfig', () => {
  it('returns the default for null / garbage input', () => {
    expect(normalizeChartConfig(null)).toEqual({
      chartType: 'bar',
      groupBy: undefined,
      measure: { kind: 'count' },
      kpiLabel: undefined,
    });
    expect(normalizeChartConfig('nope').chartType).toBe('bar');
    expect(normalizeChartConfig({ chartType: 'wat' }).chartType).toBe('bar');
  });

  it('preserves a valid stored config', () => {
    const raw = { chartType: 'pie', groupBy: 's', measure: { kind: 'sum', propId: 'n' }, kpiLabel: 'Hi' };
    expect(normalizeChartConfig(raw)).toEqual({
      chartType: 'pie',
      groupBy: 's',
      measure: { kind: 'sum', propId: 'n' },
      kpiLabel: 'Hi',
    });
  });

  it('falls back to count when a sum measure has no propId', () => {
    expect(normalizeChartConfig({ measure: { kind: 'sum' } }).measure).toEqual({ kind: 'count' });
    expect(normalizeChartConfig({ measure: { kind: 'min', propId: '' } }).measure).toEqual({ kind: 'count' });
  });

  it('drops an empty-string groupBy', () => {
    expect(normalizeChartConfig({ groupBy: '' }).groupBy).toBeUndefined();
  });
});

describe('chartCellValue', () => {
  it('reads relation/rollup/formula from their side-maps and others from props', () => {
    const r = row('a', {
      props: { n: 5 },
      relations: { rel: [{ id: 'x', title: 'X' }] },
      rollups: { ro: 42 },
      formulas: { fo: 7 },
    });
    expect(chartCellValue(r, prop('n', 'number'))).toBe(5);
    expect(chartCellValue(r, prop('rel', 'relation'))).toEqual([{ id: 'x', title: 'X' }]);
    expect(chartCellValue(r, prop('ro', 'rollup'))).toBe(42);
    expect(chartCellValue(r, prop('fo', 'formula'))).toBe(7);
    expect(chartCellValue(r, prop('missing', 'number'))).toBeNull();
  });
});

describe('bucketRows', () => {
  it('buckets by select/status option (seeded in option order, name labels)', () => {
    const rows = [
      row('a', { props: { s: 'todo' } }),
      row('b', { props: { s: 'done' } }),
      row('c', { props: { s: 'todo' } }),
    ];
    const buckets = bucketRows(rows, statusProp, 'Empty');
    expect(buckets.map((b) => b.label)).toEqual(['To do', 'Done']);
    expect(buckets.map((b) => b.rows.length)).toEqual([2, 1]);
  });

  it('collects empty cells into a trailing Empty bucket', () => {
    const rows = [
      row('a', { props: { s: 'todo' } }),
      row('b', { props: {} }),
      row('c', { props: { s: null } }),
    ];
    const buckets = bucketRows(rows, statusProp, 'Empty');
    const last = buckets[buckets.length - 1]!;
    expect(last.key).toBeNull();
    expect(last.label).toBe('Empty');
    expect(last.rows.map((r) => r.id)).toEqual(['b', 'c']);
  });

  it('keeps an empty select option bucket (zero rows) but drops an unused Empty bucket', () => {
    const rows = [row('a', { props: { s: 'todo' } })];
    const buckets = bucketRows(rows, statusProp, 'Empty');
    // "Done" stays (seeded), but the null Empty bucket is dropped (never used).
    expect(buckets.map((b) => b.label)).toEqual(['To do', 'Done']);
    expect(buckets.some((b) => b.key === null)).toBe(false);
  });

  it('buckets checkbox into true/false (✓ and —)', () => {
    const cb = prop('c', 'checkbox', { name: 'Done?' });
    const rows = [
      row('a', { props: { c: true } }),
      row('b', { props: { c: false } }),
      row('c', { props: {} }),
    ];
    const buckets = bucketRows(rows, cb, 'Empty');
    expect(buckets.map((b) => b.label)).toEqual(['✓', '—']);
    expect(buckets.map((b) => b.rows.length)).toEqual([1, 2]);
  });

  it('buckets multi_select by first member id, labelled by option name', () => {
    const ms = prop('m', 'multi_select', {
      config: { options: [{ id: 'r', name: 'Red' }, { id: 'g', name: 'Green' }] },
    });
    const rows = [
      row('a', { props: { m: ['r', 'g'] } }),
      row('b', { props: { m: ['g'] } }),
      row('c', { props: { m: [] } }),
    ];
    const buckets = bucketRows(rows, ms, 'Empty');
    expect(buckets.find((b) => b.label === 'Red')?.rows.map((r) => r.id)).toEqual(['a']);
    expect(buckets.find((b) => b.label === 'Green')?.rows.map((r) => r.id)).toEqual(['b']);
    expect(buckets.find((b) => b.key === null)?.rows.map((r) => r.id)).toEqual(['c']);
  });

  it('buckets relation by first chip, labelled by chip title', () => {
    const rel = prop('rel', 'relation');
    const rows = [
      row('a', { relations: { rel: [{ id: 'p1', title: 'Page One' }] } }),
      row('b', { relations: { rel: [{ id: 'p1', title: 'Page One' }] } }),
      row('c', { relations: { rel: [] } }),
    ];
    const buckets = bucketRows(rows, rel, 'Empty');
    expect(buckets.find((b) => b.label === 'Page One')?.rows.length).toBe(2);
    expect(buckets.find((b) => b.key === null)?.rows.map((r) => r.id)).toEqual(['c']);
  });

  it('value-buckets a text property', () => {
    const txt = prop('t', 'text');
    const rows = [
      row('a', { props: { t: 'x' } }),
      row('b', { props: { t: 'y' } }),
      row('c', { props: { t: 'x' } }),
    ];
    const buckets = bucketRows(rows, txt, 'Empty');
    expect(buckets.map((b) => b.label)).toEqual(['x', 'y']);
    expect(buckets.map((b) => b.rows.length)).toEqual([2, 1]);
  });
});

describe('measureValue', () => {
  const numProp = prop('n', 'number');
  const rows = [
    row('a', { props: { n: 10 } }),
    row('b', { props: { n: 20 } }),
    row('c', { props: { n: 30 } }),
  ];

  it('count returns row count', () => {
    expect(measureValue(rows, { kind: 'count' }, [numProp])).toBe(3);
    expect(measureValue([], { kind: 'count' }, [numProp])).toBe(0);
  });

  it('sum / average / min / max over a number prop', () => {
    expect(measureValue(rows, { kind: 'sum', propId: 'n' }, [numProp])).toBe(60);
    expect(measureValue(rows, { kind: 'average', propId: 'n' }, [numProp])).toBe(20);
    expect(measureValue(rows, { kind: 'min', propId: 'n' }, [numProp])).toBe(10);
    expect(measureValue(rows, { kind: 'max', propId: 'n' }, [numProp])).toBe(30);
  });

  it('returns 0 for an unknown measure prop or all-empty values', () => {
    expect(measureValue(rows, { kind: 'sum', propId: 'missing' }, [numProp])).toBe(0);
    const empties = [row('x', { props: {} }), row('y', { props: { n: null } })];
    expect(measureValue(empties, { kind: 'sum', propId: 'n' }, [numProp])).toBe(0);
  });

  it('sums a rollup prop from the rollups side-map', () => {
    const ro = prop('ro', 'rollup');
    const rrows = [row('a', { rollups: { ro: 4 } }), row('b', { rollups: { ro: 6 } })];
    expect(measureValue(rrows, { kind: 'sum', propId: 'ro' }, [ro])).toBe(10);
  });
});

describe('buildChartSeries', () => {
  it('builds a count-by-status bar series with parallel labels/values', () => {
    const rows = [
      row('a', { props: { s: 'todo' } }),
      row('b', { props: { s: 'done' } }),
      row('c', { props: { s: 'todo' } }),
    ];
    const config: ChartConfig = { chartType: 'bar', groupBy: 's', measure: { kind: 'count' } };
    const series = buildChartSeries(rows, [statusProp], config, LABELS);
    expect(series.labels).toEqual(['To do', 'Done']);
    expect(series.values).toEqual([2, 1]);
    expect(series.total).toBe(3);
    expect(series.max).toBe(2);
    expect(series.measureLabel).toBe('Count');
  });

  it('sums a number measure per group', () => {
    const numProp = prop('n', 'number', { name: 'Price' });
    const rows = [
      row('a', { props: { s: 'todo', n: 5 } }),
      row('b', { props: { s: 'todo', n: 15 } }),
      row('c', { props: { s: 'done', n: 100 } }),
    ];
    const config: ChartConfig = { chartType: 'bar', groupBy: 's', measure: { kind: 'sum', propId: 'n' } };
    const series = buildChartSeries(rows, [statusProp, numProp], config, LABELS);
    expect(series.labels).toEqual(['To do', 'Done']);
    expect(series.values).toEqual([20, 100]);
    expect(series.measureLabel).toBe('Sum of Price');
  });

  it('computes pie fractions that (for non-zero slices) sum to ~1', () => {
    const rows = [
      row('a', { props: { s: 'todo' } }),
      row('b', { props: { s: 'todo' } }),
      row('c', { props: { s: 'todo' } }),
      row('d', { props: { s: 'done' } }),
    ];
    const config: ChartConfig = { chartType: 'pie', groupBy: 's', measure: { kind: 'count' } };
    const series = buildChartSeries(rows, [statusProp], config, LABELS);
    expect(series.slices.map((s) => s.value)).toEqual([3, 1]);
    expect(series.slices[0]!.fraction).toBeCloseTo(0.75, 5);
    expect(series.slices[1]!.fraction).toBeCloseTo(0.25, 5);
    const sum = series.slices.reduce((a, s) => a + s.fraction, 0);
    expect(sum).toBeCloseTo(1, 5);
  });

  it('zero-total series yields zero fractions (no divide-by-zero)', () => {
    const numProp = prop('n', 'number');
    const rows = [row('a', { props: { s: 'todo' } }), row('b', { props: { s: 'done' } })];
    const config: ChartConfig = { chartType: 'pie', groupBy: 's', measure: { kind: 'sum', propId: 'n' } };
    const series = buildChartSeries(rows, [statusProp, numProp], config, LABELS);
    expect(series.total).toBe(0);
    expect(series.slices.every((s) => s.fraction === 0)).toBe(true);
  });

  it('KPI: single value over all rows, labelled by the measure (or kpiLabel)', () => {
    const rows = [row('a'), row('b'), row('c')];
    const kpi: ChartConfig = { chartType: 'kpi', measure: { kind: 'count' } };
    const series = buildChartSeries(rows, [], kpi, LABELS);
    expect(series.values).toEqual([3]);
    expect(series.labels).toEqual(['Count']);
    expect(series.total).toBe(3);

    const labelled: ChartConfig = { chartType: 'kpi', measure: { kind: 'count' }, kpiLabel: 'Tasks' };
    expect(buildChartSeries(rows, [], labelled, LABELS).labels).toEqual(['Tasks']);
  });

  it('KPI sum over a number prop ignores groupBy', () => {
    const numProp = prop('n', 'number', { name: 'Price' });
    const rows = [row('a', { props: { n: 4 } }), row('b', { props: { n: 6 } })];
    const kpi: ChartConfig = { chartType: 'kpi', groupBy: 'n', measure: { kind: 'sum', propId: 'n' } };
    const series = buildChartSeries(rows, [numProp], kpi, LABELS);
    expect(series.values).toEqual([10]);
    expect(series.labels).toEqual(['Sum of Price']);
  });

  it('a non-KPI chart with no groupBy collapses to a single all-rows aggregate', () => {
    const rows = [row('a'), row('b')];
    const config: ChartConfig = { chartType: 'bar', measure: { kind: 'count' } };
    const series = buildChartSeries(rows, [], config, LABELS);
    expect(series.values).toEqual([2]);
  });

  it('groups by the implicit title column', () => {
    const rows = [
      row('a', { title: 'Alpha' }),
      row('b', { title: 'Beta' }),
      row('c', { title: 'Alpha' }),
      row('d', { title: '' }),
    ];
    const config: ChartConfig = { chartType: 'bar', groupBy: 'title', measure: { kind: 'count' } };
    const series = buildChartSeries(rows, [], config, LABELS);
    expect(series.labels).toEqual(['Alpha', 'Beta', 'Empty']);
    expect(series.values).toEqual([2, 1, 1]);
  });

  it('returns an empty series when grouping by a missing property', () => {
    const rows = [row('a')];
    const config: ChartConfig = { chartType: 'bar', groupBy: 'ghost', measure: { kind: 'count' } };
    const series = buildChartSeries(rows, [statusProp], config, LABELS);
    expect(series.labels).toEqual([]);
    expect(series.values).toEqual([]);
    expect(series.total).toBe(0);
    expect(series.max).toBe(0);
  });
});

describe('helpers + palette', () => {
  it('formatChartValue keeps integers bare and rounds decimals', () => {
    expect(formatChartValue(5)).toBe('5');
    expect(formatChartValue(5.5)).toBe('5.50');
    expect(formatChartValue(Infinity)).toBe('0');
  });

  it('chartColor cycles the palette and handles negative/large indices', () => {
    expect(chartColor(0)).toBe(CHART_PALETTE[0]);
    expect(chartColor(CHART_PALETTE.length)).toBe(CHART_PALETTE[0]);
    expect(chartColor(-1)).toBe(CHART_PALETTE[CHART_PALETTE.length - 1]);
  });

  it('isMeasurableProp accepts number/rollup/formula only', () => {
    expect(isMeasurableProp(prop('n', 'number'))).toBe(true);
    expect(isMeasurableProp(prop('r', 'rollup'))).toBe(true);
    expect(isMeasurableProp(prop('f', 'formula'))).toBe(true);
    expect(isMeasurableProp(prop('s', 'status'))).toBe(false);
  });

  it('isGroupableProp accepts categorical + value-bucketable types', () => {
    for (const tp of ['select', 'status', 'checkbox', 'person', 'multi_select', 'relation', 'text', 'number', 'date']) {
      expect(isGroupableProp(prop('x', tp))).toBe(true);
    }
    expect(isGroupableProp(prop('files', 'files'))).toBe(false);
  });

  it('exposes the expected chart-type + measure menus and default config', () => {
    expect(CHART_TYPES).toEqual(['bar', 'line', 'pie', 'donut', 'kpi']);
    expect(MEASURE_KINDS).toEqual(['count', 'sum', 'average', 'min', 'max']);
    expect(DEFAULT_CHART_CONFIG).toEqual({ chartType: 'bar', measure: { kind: 'count' } });
  });
});
