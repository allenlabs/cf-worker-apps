import { describe, expect, it } from 'vitest';
import {
  bodyPreview,
  highlightSegments,
  languageLabel,
  paginationPages,
  timeAgo,
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

describe('bodyPreview', () => {
  it('collapses whitespace and trims', () => {
    expect(bodyPreview('  hello\n\nworld  ')).toBe('hello world');
  });
  it('returns the body unchanged when short', () => {
    expect(bodyPreview('short', 100)).toBe('short');
  });
  it('truncates with an ellipsis past max', () => {
    const long = 'a'.repeat(200);
    const out = bodyPreview(long, 50);
    expect(out.length).toBe(50);
    expect(out.endsWith('…')).toBe(true);
  });
  it('handles empty input', () => {
    expect(bodyPreview('')).toBe('');
  });
});

describe('paginationPages', () => {
  it('returns empty for total=0', () => {
    expect(paginationPages(1, 0)).toEqual([]);
  });
  it('returns [1] when total is 1', () => {
    expect(paginationPages(1, 1)).toEqual([1]);
  });
  it('lists all pages without ellipses for small totals', () => {
    expect(paginationPages(2, 4)).toEqual([1, 2, 3, 4]);
  });
  it('elides middle for large totals when current is in middle', () => {
    expect(paginationPages(5, 10)).toEqual([1, '…', 4, 5, 6, '…', 10]);
  });
  it('elides only right when current is near start', () => {
    expect(paginationPages(2, 10)).toEqual([1, 2, 3, '…', 10]);
  });
  it('elides only left when current is near end', () => {
    expect(paginationPages(9, 10)).toEqual([1, '…', 8, 9, 10]);
  });
  it('handles current=1 (window goes below 1)', () => {
    expect(paginationPages(1, 10)).toEqual([1, 2, '…', 10]);
  });
  it('handles current=total (window goes above total)', () => {
    expect(paginationPages(10, 10)).toEqual([1, '…', 9, 10]);
  });
});

describe('languageLabel', () => {
  it('returns null for empty / null input', () => {
    expect(languageLabel(null)).toBeNull();
    expect(languageLabel(undefined)).toBeNull();
    expect(languageLabel('')).toBeNull();
    expect(languageLabel('   ')).toBeNull();
  });
  it('maps known short codes', () => {
    expect(languageLabel('sh')).toBe('shell');
    expect(languageLabel('js')).toBe('JavaScript');
    expect(languageLabel('TS')).toBe('TypeScript');
    expect(languageLabel('SQL')).toBe('SQL');
  });
  it('falls back to the raw value for unknown codes', () => {
    expect(languageLabel('dockerfile')).toBe('dockerfile');
    expect(languageLabel('python')).toBe('python');
  });
});

describe('highlightSegments', () => {
  it('returns empty array for empty input', () => {
    expect(highlightSegments('')).toEqual([]);
  });
  it('splits plain text into a single non-mark segment', () => {
    expect(highlightSegments('hello world')).toEqual([
      { text: 'hello world', mark: false },
    ]);
  });
  it('extracts <b>...</b> as mark segments', () => {
    expect(highlightSegments('pre <b>hit</b> post')).toEqual([
      { text: 'pre ', mark: false },
      { text: 'hit', mark: true },
      { text: ' post', mark: false },
    ]);
  });
  it('handles multiple markers', () => {
    const out = highlightSegments('<b>a</b> mid <b>b</b>');
    expect(out.map((s) => s.text)).toEqual(['a', ' mid ', 'b']);
    expect(out.map((s) => s.mark)).toEqual([true, false, true]);
  });
  it('drops empty fragments', () => {
    expect(highlightSegments('<b>x</b>')).toEqual([{ text: 'x', mark: true }]);
  });
});
