import { describe, expect, it } from 'vitest';
import { importanceLabel, kindLabel, relativeAgo } from '~/lib/format';

describe('relativeAgo', () => {
  const now = new Date('2026-05-24T12:00:00Z');
  it('null/undefined/empty → just now', () => {
    expect(relativeAgo(null, now)).toBe('just now');
    expect(relativeAgo(undefined, now)).toBe('just now');
    expect(relativeAgo('', now)).toBe('just now');
  });
  it('malformed → just now', () => {
    expect(relativeAgo('not-a-date', now)).toBe('just now');
  });
  it('seconds', () => {
    expect(relativeAgo(new Date(now.getTime() - 30_000).toISOString(), now)).toBe('30s ago');
  });
  it('minutes', () => {
    expect(relativeAgo(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('5m ago');
  });
  it('hours', () => {
    expect(relativeAgo(new Date(now.getTime() - 3 * 3600_000).toISOString(), now)).toBe('3h ago');
  });
  it('days', () => {
    expect(relativeAgo(new Date(now.getTime() - 2 * 86400_000).toISOString(), now)).toBe('2d ago');
  });
  it('months', () => {
    expect(relativeAgo(new Date(now.getTime() - 60 * 86400_000).toISOString(), now)).toBe('2mo ago');
  });
  it('future clamps to 0s', () => {
    expect(relativeAgo(new Date(now.getTime() + 5_000).toISOString(), now)).toBe('0s ago');
  });
});

describe('importanceLabel', () => {
  it('maps 1..3', () => {
    expect(importanceLabel(1)).toBe('small');
    expect(importanceLabel(2)).toBe('medium');
    expect(importanceLabel(3)).toBe('big');
  });
  it('null/undefined → empty', () => {
    expect(importanceLabel(null)).toBe('');
    expect(importanceLabel(undefined)).toBe('');
  });
  it('out of range → empty', () => {
    expect(importanceLabel(0)).toBe('');
    expect(importanceLabel(4)).toBe('');
  });
});

describe('kindLabel', () => {
  it('maps known kinds', () => {
    expect(kindLabel('pr_merged')).toBe('PR merged');
    expect(kindLabel('issue_closed')).toBe('Issue closed');
    expect(kindLabel('focus_completed')).toBe('Focus session');
    expect(kindLabel('inbox_zeroed')).toBe('Inbox zero');
    expect(kindLabel('custom')).toBe('Custom');
  });
  it('passes through unknown', () => {
    expect(kindLabel('weird_thing')).toBe('weird_thing');
  });
});
