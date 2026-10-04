import { describe, expect, it } from 'vitest';
import { eachDate, intensityBucket, lastNDays, moodLabel, todayUtcIso } from '~/lib/format';

describe('todayUtcIso', () => {
  it('returns yyyy-mm-dd', () => {
    expect(todayUtcIso(new Date('2026-05-24T10:30:00Z'))).toBe('2026-05-24');
  });
  it('defaults to now', () => {
    expect(todayUtcIso()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('moodLabel', () => {
  it('maps 1..5', () => {
    expect(moodLabel(1)).toBe('rough');
    expect(moodLabel(2)).toBe('low');
    expect(moodLabel(3)).toBe('meh');
    expect(moodLabel(4)).toBe('good');
    expect(moodLabel(5)).toBe('great');
  });
  it('returns ? for nullish', () => {
    expect(moodLabel(null)).toBe('?');
    expect(moodLabel(undefined)).toBe('?');
  });
  it('? for out-of-range', () => {
    expect(moodLabel(0)).toBe('?');
    expect(moodLabel(6)).toBe('?');
  });
});

describe('intensityBucket', () => {
  it('null → 0', () => {
    expect(intensityBucket(null)).toBe(0);
    expect(intensityBucket(undefined)).toBe(0);
  });
  it('bucket boundaries', () => {
    expect(intensityBucket(3)).toBe(1);
    expect(intensityBucket(5)).toBe(1);
    expect(intensityBucket(6)).toBe(2);
    expect(intensityBucket(8)).toBe(2);
    expect(intensityBucket(9)).toBe(3);
    expect(intensityBucket(11)).toBe(3);
    expect(intensityBucket(12)).toBe(4);
    expect(intensityBucket(15)).toBe(4);
  });
});

describe('lastNDays', () => {
  it('returns inclusive [from, to]', () => {
    const r = lastNDays(7, new Date('2026-05-24T10:00:00Z'));
    expect(r.to).toBe('2026-05-24');
    expect(r.from).toBe('2026-05-18');
  });
  it('clamps to 1 day minimum', () => {
    const r = lastNDays(0, new Date('2026-05-24T10:00:00Z'));
    expect(r.from).toBe('2026-05-24');
    expect(r.to).toBe('2026-05-24');
  });
});

describe('eachDate', () => {
  it('inclusive enumeration', () => {
    expect(eachDate('2026-05-22', '2026-05-24')).toEqual([
      '2026-05-22', '2026-05-23', '2026-05-24',
    ]);
  });
  it('returns [] when to < from', () => {
    expect(eachDate('2026-05-24', '2026-05-22')).toEqual([]);
  });
  it('returns [] on malformed input', () => {
    expect(eachDate('not-a-date', '2026-05-24')).toEqual([]);
  });
  it('single-day range', () => {
    expect(eachDate('2026-05-24', '2026-05-24')).toEqual(['2026-05-24']);
  });
});
