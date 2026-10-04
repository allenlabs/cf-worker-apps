import { describe, expect, it } from 'vitest';
import {
  estimateMinutes,
  hostnameOf,
  readingTimeLabel,
  skipCountLabel,
  timeAgo,
  wordCount,
} from '~/lib/format';

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

describe('readingTimeLabel', () => {
  it('returns "" for null / 0 / NaN', () => {
    expect(readingTimeLabel(null)).toBe('');
    expect(readingTimeLabel(undefined)).toBe('');
    expect(readingTimeLabel(0)).toBe('');
    expect(readingTimeLabel(Number.NaN)).toBe('');
  });
  it('singularises 1 minute', () => {
    expect(readingTimeLabel(1)).toBe('1 min read');
  });
  it('pluralises 2-59 minutes', () => {
    expect(readingTimeLabel(5)).toBe('5 min read');
    expect(readingTimeLabel(59)).toBe('59 min read');
  });
  it('caps at 60+', () => {
    expect(readingTimeLabel(60)).toBe('60+ min read');
    expect(readingTimeLabel(999)).toBe('60+ min read');
  });
});

describe('hostnameOf', () => {
  it('returns the bare hostname', () => {
    expect(hostnameOf('https://example.com/foo/bar')).toBe('example.com');
  });
  it('strips the leading www.', () => {
    expect(hostnameOf('https://www.example.com/x')).toBe('example.com');
  });
  it('returns "" for invalid URLs', () => {
    expect(hostnameOf('not-a-url')).toBe('');
    expect(hostnameOf('')).toBe('');
  });
});

describe('skipCountLabel', () => {
  it('returns "" for 0 / negative / null', () => {
    expect(skipCountLabel(0)).toBe('');
    expect(skipCountLabel(-3)).toBe('');
    expect(skipCountLabel(null)).toBe('');
    expect(skipCountLabel(undefined)).toBe('');
    expect(skipCountLabel(Number.NaN)).toBe('');
  });
  it('singularises 1', () => {
    expect(skipCountLabel(1)).toBe('skipped 1 time');
  });
  it('pluralises 2+', () => {
    expect(skipCountLabel(7)).toBe('skipped 7 times');
  });
});

describe('wordCount', () => {
  it('returns 0 for empty', () => {
    expect(wordCount('')).toBe(0);
  });
  it('counts whitespace-separated tokens', () => {
    expect(wordCount('one two three')).toBe(3);
  });
  it('ignores extra whitespace', () => {
    expect(wordCount('   one  two   ')).toBe(2);
  });
  it('handles newlines + tabs', () => {
    expect(wordCount('one\ntwo\tthree four')).toBe(4);
  });
});

describe('estimateMinutes', () => {
  it('returns 1 for 0 / negative / NaN words', () => {
    expect(estimateMinutes(0)).toBe(1);
    expect(estimateMinutes(-1)).toBe(1);
    expect(estimateMinutes(Number.NaN)).toBe(1);
  });
  it('returns 1 for short articles', () => {
    expect(estimateMinutes(10)).toBe(1);
    expect(estimateMinutes(150)).toBe(1);
  });
  it('rounds to nearest minute at 220 wpm', () => {
    expect(estimateMinutes(220)).toBe(1);
    expect(estimateMinutes(440)).toBe(2);
    expect(estimateMinutes(550)).toBe(3); // 2.5 → 3
  });
});
