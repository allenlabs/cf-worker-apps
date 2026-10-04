import { describe, expect, it } from 'vitest';
import { timeAgo, untilNow } from '~/lib/format';

describe('timeAgo', () => {
  const NOW = 1_700_000_000_000;
  it('returns "just now" within a minute', () => {
    expect(timeAgo(NOW - 30_000, NOW)).toBe('just now');
  });
  it('returns Xm ago within an hour', () => {
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
  });
  it('returns Xh ago within a day', () => {
    expect(timeAgo(NOW - 3 * 60 * 60_000, NOW)).toBe('3h ago');
  });
  it('returns Xd ago within a month', () => {
    expect(timeAgo(NOW - 4 * 24 * 60 * 60_000, NOW)).toBe('4d ago');
  });
  it('returns a date string at month boundary', () => {
    expect(timeAgo(NOW - 60 * 24 * 60 * 60_000, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('returns "" for non-finite input', () => {
    expect(timeAgo(NaN, NOW)).toBe('');
  });
  it('accepts a string ISO input', () => {
    expect(timeAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
  });
  it('accepts a Date instance input', () => {
    expect(timeAgo(new Date(NOW - 30_000), NOW)).toBe('just now');
  });
});

describe('untilNow', () => {
  const NOW = 1_700_000_000_000;
  it('returns "ready" when target is in the past', () => {
    expect(untilNow(NOW - 1000, NOW)).toBe('ready');
  });
  it('returns minutes when within an hour', () => {
    expect(untilNow(NOW + 10 * 60_000, NOW)).toBe('in 10m');
  });
  it('returns hours when within a day', () => {
    expect(untilNow(NOW + 5 * 60 * 60_000, NOW)).toBe('in 5h');
  });
  it('returns days otherwise', () => {
    expect(untilNow(NOW + 3 * 24 * 60 * 60_000, NOW)).toBe('in 3d');
  });
  it('returns "" for bad input', () => {
    expect(untilNow(NaN, NOW)).toBe('');
  });
});
