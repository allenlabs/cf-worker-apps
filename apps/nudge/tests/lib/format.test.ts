import { describe, expect, it } from 'vitest';
import { timeAgo, timeUntil } from '~/lib/format';

describe('timeAgo', () => {
  const NOW = new Date('2026-05-24T10:00:00Z').getTime();
  it('"just now" < 60s', () => {
    expect(timeAgo(NOW - 5_000, NOW)).toBe('just now');
  });
  it('Nm ago < 1h', () => {
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });
  it('Nh ago < 1d', () => {
    expect(timeAgo(NOW - 3 * 3600_000, NOW)).toBe('3h ago');
  });
  it('Nd ago < 30d', () => {
    expect(timeAgo(NOW - 5 * 86_400_000, NOW)).toBe('5d ago');
  });
  it('iso date >= 30d', () => {
    expect(timeAgo(NOW - 60 * 86_400_000, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('handles ISO string input', () => {
    expect(timeAgo(new Date(NOW - 5_000).toISOString(), NOW)).toBe('just now');
  });
  it('returns empty string for invalid input', () => {
    expect(timeAgo('not a date', NOW)).toBe('');
  });
  it('clamps negative diff to 0', () => {
    expect(timeAgo(NOW + 5_000, NOW)).toBe('just now');
  });
  it('accepts a Date object', () => {
    expect(timeAgo(new Date(NOW - 5_000), NOW)).toBe('just now');
  });
});

describe('timeUntil', () => {
  const NOW = new Date('2026-05-24T10:00:00Z').getTime();
  it('returns "now" for past times', () => {
    expect(timeUntil(NOW - 1000, NOW)).toBe('now');
  });
  it('returns "in <1 min" for sub-minute deltas', () => {
    expect(timeUntil(NOW + 30_000, NOW)).toBe('in <1 min');
  });
  it('returns "in N min" for minute deltas', () => {
    expect(timeUntil(NOW + 5 * 60_000, NOW)).toBe('in 5 min');
  });
  it('returns "in N h" for hour deltas', () => {
    expect(timeUntil(NOW + 3 * 3600_000, NOW)).toBe('in 3 h');
  });
  it('returns "in N d" for day deltas', () => {
    expect(timeUntil(NOW + 5 * 86_400_000, NOW)).toBe('in 5 d');
  });
  it('returns iso date for >= 30d', () => {
    expect(timeUntil(NOW + 60 * 86_400_000, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('handles invalid input', () => {
    expect(timeUntil('not a date', NOW)).toBe('');
  });
  it('accepts ISO + Date inputs', () => {
    expect(timeUntil(new Date(NOW + 60_000), NOW)).toBe('in 1 min');
    expect(timeUntil(new Date(NOW + 60_000).toISOString(), NOW)).toBe('in 1 min');
  });
});
