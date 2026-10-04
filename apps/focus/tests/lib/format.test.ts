import { describe, expect, it } from 'vitest';
import { clockTime, dayLabel, humanMinutes, mmss, timeAgo } from '~/lib/format';

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
  it('accepts an ISO string', () => {
    expect(timeAgo(new Date(NOW - 30_000).toISOString(), NOW)).toBe('just now');
  });
  it('accepts a Date instance', () => {
    expect(timeAgo(new Date(NOW - 30_000), NOW)).toBe('just now');
  });
});

describe('clockTime', () => {
  it('formats HH:MM in 24h', () => {
    const d = new Date(2026, 4, 24, 14, 47, 0);
    expect(clockTime(d)).toBe('14:47');
  });
  it('pads single-digit hours/minutes', () => {
    const d = new Date(2026, 0, 1, 3, 5, 0);
    expect(clockTime(d)).toBe('03:05');
  });
  it('returns "" for bad input', () => {
    expect(clockTime(NaN)).toBe('');
  });
  it('accepts a string', () => {
    const d = new Date(2026, 4, 24, 14, 47, 0);
    expect(clockTime(d.toISOString())).toBe('14:47');
  });
});

describe('mmss', () => {
  it('formats whole minutes', () => {
    expect(mmss(25 * 60)).toBe('25:00');
  });
  it('formats with seconds remainder', () => {
    expect(mmss(125)).toBe('2:05');
  });
  it('clamps negative to 0:00', () => {
    expect(mmss(-30)).toBe('0:00');
  });
  it('floors non-integer seconds', () => {
    expect(mmss(59.9)).toBe('0:59');
  });
});

describe('humanMinutes', () => {
  it('returns "0 min" for zero', () => {
    expect(humanMinutes(0)).toBe('0 min');
  });
  it('returns "X min" under an hour', () => {
    expect(humanMinutes(45)).toBe('45 min');
  });
  it('returns "X h" on whole hours', () => {
    expect(humanMinutes(120)).toBe('2 h');
  });
  it('returns "X h Y min" with mixed', () => {
    expect(humanMinutes(75)).toBe('1 h 15 min');
  });
  it('clamps negatives to 0 min', () => {
    expect(humanMinutes(-10)).toBe('0 min');
  });
});

describe('dayLabel', () => {
  const today = new Date(2026, 4, 24); // May 24 2026
  it('returns "today" for the same calendar day', () => {
    expect(dayLabel(new Date(2026, 4, 24, 12, 0, 0), today)).toBe('today');
  });
  it('returns "yesterday"', () => {
    expect(dayLabel(new Date(2026, 4, 23), today)).toBe('yesterday');
  });
  it('returns "N days ago"', () => {
    expect(dayLabel(new Date(2026, 4, 19), today)).toBe('5 days ago');
  });
  it('returns ISO date for future', () => {
    expect(dayLabel(new Date(2026, 4, 30), today)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
  it('returns "" for bad date', () => {
    expect(dayLabel('not-a-date', today)).toBe('');
  });
});
