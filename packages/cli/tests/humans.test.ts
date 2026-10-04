import { describe, expect, it } from 'vitest';

import {
  formatClock,
  formatDuration,
  formatPromptSnippet,
  formatRelativeAge,
  formatSessionWindow,
  truncate,
} from '../src/lib/humans.js';

describe('formatClock', () => {
  it('zero-pads hours and minutes', () => {
    const d = new Date(2026, 4, 24, 7, 3);
    expect(formatClock(d)).toBe('07:03');
  });
  it('accepts an epoch ms number', () => {
    const d = new Date(2026, 4, 24, 14, 47);
    expect(formatClock(d.getTime())).toBe('14:47');
  });
});

describe('formatDuration', () => {
  it('returns "now" for zero or negative input', () => {
    expect(formatDuration(0)).toBe('now');
    expect(formatDuration(-100)).toBe('now');
    expect(formatDuration(Number.NaN)).toBe('now');
  });
  it('formats sub-hour durations as min', () => {
    expect(formatDuration(60_000)).toBe('1 min');
    expect(formatDuration(25 * 60_000)).toBe('25 min');
  });
  it('formats whole hours', () => {
    expect(formatDuration(60 * 60_000)).toBe('1 hr');
    expect(formatDuration(2 * 60 * 60_000)).toBe('2 hr');
  });
  it('formats hr + min combos', () => {
    expect(formatDuration((60 + 5) * 60_000)).toBe('1 hr 5 min');
  });
});

describe('formatSessionWindow', () => {
  it('combines duration + ends-at clock', () => {
    const ends = new Date(2026, 4, 24, 14, 47);
    expect(formatSessionWindow(25, ends)).toBe('(25 min — ends at 14:47)');
  });
});

describe('formatPromptSnippet', () => {
  it('shows minutes remaining when in-session', () => {
    const start = Date.UTC(2026, 4, 24, 10, 0, 0);
    const now = start + 11 * 60_000; // 11 min in
    expect(formatPromptSnippet(start, 25, now)).toBe('focus 14m left');
  });
  it('accepts Date objects', () => {
    const start = new Date(Date.UTC(2026, 4, 24, 10, 0, 0));
    const now = new Date(start.getTime() + 11 * 60_000);
    expect(formatPromptSnippet(start, 25, now)).toBe('focus 14m left');
  });
  it('reports overrun when past target', () => {
    const start = Date.UTC(2026, 4, 24, 10, 0, 0);
    const now = start + 28 * 60_000; // 3 min over
    expect(formatPromptSnippet(start, 25, now)).toBe('focus over by 3m');
  });
  it('rounds remaining minutes up (so 1m 1s left shows 2m, never 0m)', () => {
    const start = Date.UTC(2026, 4, 24, 10, 0, 0);
    const now = start + (25 * 60_000 - 1_001); // 1.001 s before end
    expect(formatPromptSnippet(start, 25, now)).toBe('focus 1m left');
  });
  it('default `now` works without exploding', () => {
    expect(typeof formatPromptSnippet(Date.now(), 25)).toBe('string');
  });
});

describe('formatRelativeAge', () => {
  const now = Date.UTC(2026, 4, 24, 12, 0, 0);
  it('returns "just now" for sub-minute', () => {
    expect(formatRelativeAge(now - 5_000, now)).toBe('just now');
  });
  it('returns m for sub-hour', () => {
    expect(formatRelativeAge(now - 5 * 60_000, now)).toBe('5m ago');
  });
  it('returns h for sub-day', () => {
    expect(formatRelativeAge(now - 3 * 60 * 60_000, now)).toBe('3h ago');
  });
  it('returns d for multi-day', () => {
    expect(formatRelativeAge(now - 5 * 24 * 60 * 60_000, now)).toBe('5d ago');
  });
  it('accepts Date inputs', () => {
    expect(formatRelativeAge(new Date(now - 5_000), new Date(now))).toBe('just now');
  });
  it('default `now` works', () => {
    expect(typeof formatRelativeAge(Date.now())).toBe('string');
  });
});

describe('truncate', () => {
  it('collapses whitespace', () => {
    expect(truncate('  a  b  c  ')).toBe('a b c');
  });
  it('returns short strings unchanged', () => {
    expect(truncate('short', 80)).toBe('short');
  });
  it('ellipsizes past max', () => {
    const text = 'a'.repeat(100);
    const out = truncate(text, 10);
    expect(out.length).toBe(10);
    expect(out.endsWith('…')).toBe(true);
  });
});
