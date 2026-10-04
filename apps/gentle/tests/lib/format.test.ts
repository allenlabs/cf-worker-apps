import { describe, it, expect } from 'vitest';
import {
  eachDate,
  intensityBucket,
  lastNDays,
  todayUtcIso,
} from '~/lib/format';

describe('todayUtcIso', () => {
  it('returns yyyy-mm-dd', () => {
    expect(todayUtcIso(new Date('2026-05-24T23:59:59Z'))).toBe('2026-05-24');
  });
});

describe('intensityBucket', () => {
  it('null is bucket 0', () => {
    expect(intensityBucket(null)).toBe(0);
    expect(intensityBucket(undefined)).toBe(0);
  });
  it('clamps to 0..5', () => {
    expect(intensityBucket(0)).toBe(0);
    expect(intensityBucket(3)).toBe(3);
    expect(intensityBucket(5)).toBe(5);
    expect(intensityBucket(99)).toBe(5);
    expect(intensityBucket(-1)).toBe(0);
  });
});

describe('lastNDays', () => {
  it('returns inclusive [from, to] for N days', () => {
    const now = new Date('2026-05-24T12:00:00Z');
    const { from, to } = lastNDays(7, now);
    expect(to).toBe('2026-05-24');
    expect(from).toBe('2026-05-18');
  });
  it('handles 1 day', () => {
    const now = new Date('2026-05-24T12:00:00Z');
    expect(lastNDays(1, now)).toEqual({ from: '2026-05-24', to: '2026-05-24' });
  });
  it('clamps to >= 1', () => {
    const now = new Date('2026-05-24T12:00:00Z');
    expect(lastNDays(0, now)).toEqual({ from: '2026-05-24', to: '2026-05-24' });
  });
});

describe('eachDate', () => {
  it('iterates inclusively', () => {
    expect(eachDate('2026-05-22', '2026-05-24')).toEqual([
      '2026-05-22',
      '2026-05-23',
      '2026-05-24',
    ]);
  });
  it('empty when to < from', () => {
    expect(eachDate('2026-05-24', '2026-05-22')).toEqual([]);
  });
  it('empty on garbage', () => {
    expect(eachDate('bad', '2026-05-24')).toEqual([]);
  });
});
