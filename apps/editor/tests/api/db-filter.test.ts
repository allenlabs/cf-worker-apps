// Phase 15 unit tests for the filter / sort / group evaluation engine
// (db-filter.ts) + the dbRowsImpl view-config application path.

import { describe, it, expect } from 'vitest';
import {
  evalCondition,
  evalGroup,
  applyFilterGroup,
  applySorts,
  groupRows,
  normalizeFilterGroup,
  readCell,
  compareValues,
  type EvalRow,
  type FilterGroup,
} from '@api/handlers/db-filter';

const ROW = (title: string, props: Record<string, unknown> = {}): EvalRow => ({ title, props });
// Fixed clock: 2026-06-02T00:00:00Z.
const NOW = Date.UTC(2026, 5, 2, 0, 0, 0);

describe('readCell', () => {
  it('reads the implicit title column via "title"', () => {
    expect(readCell(ROW('Hi', { p1: 'x' }), 'title')).toBe('Hi');
  });
  it('reads a prop by id, null when absent', () => {
    expect(readCell(ROW('Hi', { p1: 'x' }), 'p1')).toBe('x');
    expect(readCell(ROW('Hi'), 'missing')).toBeNull();
  });
});

describe('evalCondition — text/select/number/checkbox/multi', () => {
  const row = ROW('Roadmap', {
    name: 'Acme Corp',
    n: 42,
    done: true,
    status: 'doing',
    tags: ['a', 'b'],
    blank: '',
  });

  it('contains / not_contains (case-insensitive)', () => {
    expect(evalCondition(row, { propId: 'name', op: 'contains', value: 'acme' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'name', op: 'not_contains', value: 'zzz' }, NOW)).toBe(true);
  });
  it('equals / not_equals / is / is_not', () => {
    expect(evalCondition(row, { propId: 'status', op: 'is', value: 'doing' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'status', op: 'is_not', value: 'done' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'name', op: 'equals', value: 'Acme Corp' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'name', op: 'not_equals', value: 'x' }, NOW)).toBe(true);
  });
  it('number gt/gte/lt/lte', () => {
    expect(evalCondition(row, { propId: 'n', op: 'gt', value: 40 }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'n', op: 'gte', value: 42 }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'n', op: 'lt', value: 40 }, NOW)).toBe(false);
    expect(evalCondition(row, { propId: 'n', op: 'lte', value: 42 }, NOW)).toBe(true);
    // Non-numeric cell or value → false (never throws).
    expect(evalCondition(row, { propId: 'name', op: 'gt', value: 1 }, NOW)).toBe(false);
  });
  it('checkbox checked/unchecked', () => {
    expect(evalCondition(row, { propId: 'done', op: 'checked' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'done', op: 'unchecked' }, NOW)).toBe(false);
  });
  it('multi_select / relation has / has_not', () => {
    expect(evalCondition(row, { propId: 'tags', op: 'has', value: 'a' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'tags', op: 'has_not', value: 'z' }, NOW)).toBe(true);
  });
  it('is_empty / is_not_empty', () => {
    expect(evalCondition(row, { propId: 'blank', op: 'is_empty' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'name', op: 'is_not_empty' }, NOW)).toBe(true);
    expect(evalCondition(ROW('x', { tags: [] }), { propId: 'tags', op: 'is_empty' }, NOW)).toBe(true);
  });
  it('unknown op defaults to passing', () => {
    expect(evalCondition(row, { propId: 'name', op: 'bogus' as never }, NOW)).toBe(true);
  });
});

describe('evalCondition — date operators', () => {
  const row = ROW('D', { due: '2026-06-05', past: '2026-05-01' });
  it('before / after / on', () => {
    expect(evalCondition(row, { propId: 'due', op: 'after', value: '2026-06-01' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'due', op: 'before', value: '2026-06-10' }, NOW)).toBe(true);
    expect(evalCondition(row, { propId: 'due', op: 'on', value: '2026-06-05' }, NOW)).toBe(true);
  });
  it('within_days is relative to the injected now', () => {
    // due is 3 days out from NOW (2026-06-02) → within 7 days.
    expect(evalCondition(row, { propId: 'due', op: 'within_days', value: 7 }, NOW)).toBe(true);
    // ...not within 1 day.
    expect(evalCondition(row, { propId: 'due', op: 'within_days', value: 1 }, NOW)).toBe(false);
  });
  it('returns false for an unparsable date', () => {
    expect(evalCondition(ROW('x', { d: 'nope' }), { propId: 'd', op: 'before', value: '2026-01-01' }, NOW)).toBe(false);
  });
});

describe('evalGroup — AND / OR + nesting', () => {
  const row = ROW('R', { a: 'x', n: 5 });
  it('AND requires every child', () => {
    const g: FilterGroup = {
      conjunction: 'and',
      conditions: [
        { propId: 'a', op: 'is', value: 'x' },
        { propId: 'n', op: 'gt', value: 1 },
      ],
    };
    expect(evalGroup(row, g, NOW)).toBe(true);
    expect(evalGroup(ROW('R', { a: 'y', n: 5 }), g, NOW)).toBe(false);
  });
  it('OR needs any child', () => {
    const g: FilterGroup = {
      conjunction: 'or',
      conditions: [
        { propId: 'a', op: 'is', value: 'nope' },
        { propId: 'n', op: 'gt', value: 1 },
      ],
    };
    expect(evalGroup(row, g, NOW)).toBe(true);
  });
  it('supports a nested group (one level)', () => {
    const g: FilterGroup = {
      conjunction: 'and',
      conditions: [
        { propId: 'a', op: 'is', value: 'x' },
        {
          conjunction: 'or',
          conditions: [
            { propId: 'n', op: 'gt', value: 100 },
            { propId: 'n', op: 'lt', value: 10 },
          ],
        },
      ],
    };
    expect(evalGroup(row, g, NOW)).toBe(true);
  });
  it('empty group passes', () => {
    expect(evalGroup(row, { conjunction: 'and', conditions: [] }, NOW)).toBe(true);
  });
});

describe('applyFilterGroup', () => {
  it('filters a list and preserves order', () => {
    const rows = [ROW('a', { x: 1 }), ROW('b', { x: 2 }), ROW('c', { x: 3 })];
    const out = applyFilterGroup(rows, { conjunction: 'and', conditions: [{ propId: 'x', op: 'gte', value: 2 }] }, NOW);
    expect(out.map((r) => r.title)).toEqual(['b', 'c']);
  });
});

describe('applySorts + compareValues', () => {
  it('compareValues sorts nulls/empties last', () => {
    expect(compareValues(null, 1)).toBeGreaterThan(0);
    expect(compareValues(1, null)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
    expect(compareValues(1, 2)).toBeLessThan(0);
    expect(compareValues('a', 'b')).toBeLessThan(0);
  });
  it('multi-level sort: primary asc, secondary desc', () => {
    const rows = [
      ROW('r1', { g: 'a', n: 1 }),
      ROW('r2', { g: 'b', n: 9 }),
      ROW('r3', { g: 'a', n: 5 }),
    ];
    const out = applySorts(rows, [
      { propId: 'g', dir: 'asc' },
      { propId: 'n', dir: 'desc' },
    ]);
    expect(out.map((r) => r.title)).toEqual(['r3', 'r1', 'r2']);
  });
  it('empty sort list returns the same array', () => {
    const rows = [ROW('a'), ROW('b')];
    expect(applySorts(rows, [])).toBe(rows);
  });
});

describe('groupRows', () => {
  it('buckets by a single-value prop with null bucket last', () => {
    const rows = [
      ROW('r1', { s: 'todo' }),
      ROW('r2', { s: 'done' }),
      ROW('r3', {}),
      ROW('r4', { s: 'todo' }),
    ];
    const groups = groupRows(rows, 's');
    expect(groups.map((g) => g.key)).toEqual(['todo', 'done', null]);
    expect(groups[0]!.rows.map((r) => r.title)).toEqual(['r1', 'r4']);
    expect(groups[2]!.rows.map((r) => r.title)).toEqual(['r3']);
  });
  it('places a multi-value row into each bucket', () => {
    const groups = groupRows([ROW('r1', { tags: ['x', 'y'] }), ROW('r2', { tags: [] })], 'tags');
    expect(groups.find((g) => g.key === 'x')!.rows).toHaveLength(1);
    expect(groups.find((g) => g.key === 'y')!.rows).toHaveLength(1);
    expect(groups.find((g) => g.key === null)!.rows).toHaveLength(1);
  });
});

describe('normalizeFilterGroup', () => {
  it('returns a provided filterGroup (coercing conjunction)', () => {
    const g = normalizeFilterGroup({ filterGroup: { conjunction: 'or', conditions: [] } });
    expect(g).toEqual({ conjunction: 'or', conditions: [] });
    const g2 = normalizeFilterGroup({ filterGroup: { conjunction: 'weird' as never, conditions: [] } });
    expect(g2!.conjunction).toBe('and');
  });
  it('converts a legacy flat filters array to an AND group', () => {
    const g = normalizeFilterGroup({ filters: [{ propId: 'a', value: 'x' }] });
    expect(g).toEqual({
      conjunction: 'and',
      conditions: [{ propId: 'a', op: 'contains', value: 'x' }],
    });
  });
  it('returns null when there are no filters', () => {
    expect(normalizeFilterGroup({})).toBeNull();
    expect(normalizeFilterGroup({ filters: [] })).toBeNull();
  });
});
