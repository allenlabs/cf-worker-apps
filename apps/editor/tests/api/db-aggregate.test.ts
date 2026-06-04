// Unit tests for the table-view aggregation footer math (web app/lib).
// Pure, client-side computation over already-loaded cell values.

import { describe, it, expect } from 'vitest';
import {
  aggOptionsForType,
  AGG_OPTIONS_FOR_TYPE,
  computeAggregation,
  isEmptyValue,
  AGG_LABEL_KEY,
  type AggregationOp,
} from '~/lib/db-aggregate';

const compute = (op: AggregationOp, values: unknown[], type = 'text') =>
  computeAggregation(op, values, type).text;

describe('aggOptionsForType', () => {
  it('offers number-specific ops for number/rollup', () => {
    for (const type of ['number', 'rollup']) {
      const ops = aggOptionsForType(type);
      expect(ops[0]).toBe('none');
      expect(ops).toEqual(expect.arrayContaining(['sum', 'average', 'median', 'min', 'max', 'range']));
      // universal ops always present
      expect(ops).toEqual(expect.arrayContaining(['count_all', 'count_unique', 'percent_empty']));
    }
  });

  it('offers checkbox-specific ops', () => {
    const ops = aggOptionsForType('checkbox');
    expect(ops).toEqual(expect.arrayContaining(['checked', 'unchecked', 'percent_checked']));
    expect(ops).not.toContain('sum');
  });

  it('offers date-specific ops for date/created_time/last_edited_time', () => {
    for (const type of ['date', 'created_time', 'last_edited_time']) {
      const ops = aggOptionsForType(type);
      expect(ops).toEqual(expect.arrayContaining(['earliest', 'latest', 'date_range']));
    }
  });

  it('offers only none + universal ops for text/select/etc.', () => {
    for (const type of ['text', 'select', 'multi_select', 'status', 'person', 'url', 'relation', 'formula']) {
      const ops = aggOptionsForType(type);
      expect(ops[0]).toBe('none');
      expect(ops).not.toContain('sum');
      expect(ops).not.toContain('checked');
      expect(ops).not.toContain('earliest');
      expect(ops).toEqual(expect.arrayContaining(['count_all', 'count_empty', 'count_not_empty']));
    }
  });

  it('AGG_OPTIONS_FOR_TYPE is the same function (spec alias)', () => {
    expect(AGG_OPTIONS_FOR_TYPE).toBe(aggOptionsForType);
  });

  it('every op has a label key', () => {
    const all = new Set<AggregationOp>();
    for (const type of ['number', 'checkbox', 'date', 'text']) {
      for (const o of aggOptionsForType(type)) all.add(o);
    }
    for (const o of all) expect(AGG_LABEL_KEY[o]).toBeTruthy();
  });
});

describe('isEmptyValue', () => {
  it('treats null/undefined/empty-string as empty', () => {
    expect(isEmptyValue(null)).toBe(true);
    expect(isEmptyValue(undefined)).toBe(true);
    expect(isEmptyValue('')).toBe(true);
  });
  it('treats empty arrays as empty, non-empty as not', () => {
    expect(isEmptyValue([])).toBe(true);
    expect(isEmptyValue(['a'])).toBe(false);
  });
  it('treats a formula error sentinel as empty', () => {
    expect(isEmptyValue({ __error: 'bad' })).toBe(true);
    expect(isEmptyValue({})).toBe(true);
  });
  it('treats 0 and false as NOT empty', () => {
    expect(isEmptyValue(0)).toBe(false);
    expect(isEmptyValue(false)).toBe(false);
  });
});

describe('computeAggregation — none + empty set', () => {
  it("'none' is always blank", () => {
    expect(compute('none', [1, 2, 3], 'number')).toBe('');
    expect(compute('none', [], 'number')).toBe('');
  });
  it('count_all on an empty set is 0 (not blank)', () => {
    expect(compute('count_all', [], 'text')).toBe('0');
  });
});

describe('computeAggregation — universal ops', () => {
  const vals = ['a', '', null, 'a', 'b', []];
  it('count_all counts every loaded row', () => {
    expect(compute('count_all', vals)).toBe('6');
  });
  it('count_empty / count_not_empty split on emptiness', () => {
    expect(compute('count_empty', vals)).toBe('3'); // '', null, []
    expect(compute('count_not_empty', vals)).toBe('3'); // 'a','a','b'
  });
  it('count_unique counts distinct non-empty values', () => {
    expect(compute('count_unique', vals)).toBe('2'); // 'a','b'
  });
  it('count_unique expands array members', () => {
    expect(compute('count_unique', [['x', 'y'], ['y', 'z'], []], 'multi_select')).toBe('3');
  });
  it('percent_empty / percent_not_empty round to whole percents', () => {
    expect(compute('percent_empty', vals)).toBe('50%');
    expect(compute('percent_not_empty', vals)).toBe('50%');
  });
  it('percent of an empty set is 0%', () => {
    expect(compute('percent_empty', [])).toBe('0%');
  });
});

describe('computeAggregation — number ops', () => {
  const nums = [1, 2, 3, 4];
  it('sum / average / median / min / max / range', () => {
    expect(compute('sum', nums, 'number')).toBe('10');
    expect(compute('average', nums, 'number')).toBe('2.50');
    expect(compute('median', nums, 'number')).toBe('2.50');
    expect(compute('median', [1, 2, 3], 'number')).toBe('2');
    expect(compute('min', nums, 'number')).toBe('1');
    expect(compute('max', nums, 'number')).toBe('4');
    expect(compute('range', nums, 'number')).toBe('3');
  });
  it('coerces numeric strings and ignores non-numeric', () => {
    expect(compute('sum', ['10', '5', 'abc', null], 'number')).toBe('15');
  });
  it('returns blank when no numeric values present', () => {
    expect(compute('sum', ['abc', null, ''], 'number')).toBe('');
    expect(compute('average', [], 'number')).toBe('');
  });
  it('formats integers bare and decimals to 2 places', () => {
    expect(compute('sum', [1.5, 1.5], 'number')).toBe('3');
    expect(compute('average', [1, 2], 'number')).toBe('1.50');
  });
});

describe('computeAggregation — checkbox ops', () => {
  const checks = [true, false, true, null];
  it('checked / unchecked / percent_checked', () => {
    expect(compute('checked', checks, 'checkbox')).toBe('2');
    expect(compute('unchecked', checks, 'checkbox')).toBe('2'); // false + null
    expect(compute('percent_checked', checks, 'checkbox')).toBe('50%');
  });
  it('percent_checked of an empty set is 0%', () => {
    expect(compute('percent_checked', [], 'checkbox')).toBe('0%');
  });
});

describe('computeAggregation — date ops', () => {
  const dates = ['2026-01-01', '2026-01-10', '2026-01-05', null, 'not-a-date'];
  it('earliest / latest pick the bounds', () => {
    expect(compute('earliest', dates, 'date')).toBe(new Date('2026-01-01T00:00:00').toLocaleDateString());
    expect(compute('latest', dates, 'date')).toBe(new Date('2026-01-10T00:00:00').toLocaleDateString());
  });
  it('date_range reports the whole-day span', () => {
    expect(compute('date_range', dates, 'date')).toBe('9 days');
  });
  it('date_range of a single day reads "1 day"', () => {
    expect(compute('date_range', ['2026-01-01', '2026-01-02'], 'date')).toBe('1 day');
  });
  it('returns blank when no valid dates present', () => {
    expect(compute('earliest', [null, 'x'], 'date')).toBe('');
  });
  it('handles full ISO timestamps too', () => {
    expect(compute('earliest', ['2026-03-02T08:00:00.000Z'], 'date')).toBe(
      new Date('2026-03-02T08:00:00.000Z').toLocaleDateString(),
    );
  });
});
