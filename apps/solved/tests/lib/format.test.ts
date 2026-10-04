import { describe, it, expect } from 'vitest';
import { bodyPreview, highlightSegments, timeAgo } from '~/lib/format';

describe('timeAgo', () => {
  const now = new Date('2026-05-24T12:00:00Z').getTime();
  it('just now', () => {
    expect(timeAgo(new Date(now - 1000), now)).toBe('just now');
  });
  it('minutes', () => {
    expect(timeAgo(new Date(now - 5 * 60_000), now)).toBe('5m ago');
  });
  it('hours', () => {
    expect(timeAgo(new Date(now - 3 * 60 * 60_000), now)).toBe('3h ago');
  });
  it('days', () => {
    expect(timeAgo(new Date(now - 5 * 24 * 60 * 60_000), now)).toBe('5d ago');
  });
  it('beyond 30 days falls back to iso date', () => {
    const ts = new Date('2025-12-01T00:00:00Z');
    expect(timeAgo(ts, now)).toBe('2025-12-01');
  });
  it('returns "" for invalid input', () => {
    expect(timeAgo('garbage', now)).toBe('');
  });
  it('accepts number input', () => {
    expect(timeAgo(now - 30_000, now)).toBe('just now');
  });
});

describe('bodyPreview', () => {
  it('collapses whitespace + truncates', () => {
    expect(bodyPreview('foo  bar\n\nbaz')).toBe('foo bar baz');
    expect(bodyPreview('a'.repeat(200), 10)).toBe('aaaaaaaaa…');
  });
  it('returns "" for whitespace-only body', () => {
    expect(bodyPreview('   \n  ')).toBe('');
  });
});

describe('highlightSegments', () => {
  it('splits b-tag spans', () => {
    expect(highlightSegments('hello <b>world</b>!')).toEqual([
      { text: 'hello ', mark: false },
      { text: 'world', mark: true },
      { text: '!', mark: false },
    ]);
  });
  it('returns [] for empty input', () => {
    expect(highlightSegments('')).toEqual([]);
  });
  it('handles multiple matches', () => {
    expect(highlightSegments('<b>a</b> and <b>b</b>')).toEqual([
      { text: 'a', mark: true },
      { text: ' and ', mark: false },
      { text: 'b', mark: true },
    ]);
  });
});
