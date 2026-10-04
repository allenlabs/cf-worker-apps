import { describe, expect, it } from 'vitest';
import { isTarget, relativeAgo, targetLabel } from '~/lib/format';

describe('relativeAgo', () => {
  const now = new Date('2026-05-24T12:00:00Z');
  it('nullish/empty/malformed → just now', () => {
    expect(relativeAgo(null, now)).toBe('just now');
    expect(relativeAgo(undefined, now)).toBe('just now');
    expect(relativeAgo('', now)).toBe('just now');
    expect(relativeAgo('not-a-date', now)).toBe('just now');
  });
  it('seconds/minutes/hours/days', () => {
    expect(relativeAgo(new Date(now.getTime() - 30_000).toISOString(), now)).toBe('30s ago');
    expect(relativeAgo(new Date(now.getTime() - 5 * 60_000).toISOString(), now)).toBe('5m ago');
    expect(relativeAgo(new Date(now.getTime() - 3 * 3600_000).toISOString(), now)).toBe('3h ago');
    expect(relativeAgo(new Date(now.getTime() - 2 * 86400_000).toISOString(), now)).toBe('2d ago');
  });
  it('future clamps', () => {
    expect(relativeAgo(new Date(now.getTime() + 5_000).toISOString(), now)).toBe('0s ago');
  });
});

describe('isTarget', () => {
  it('accepts known targets', () => {
    expect(isTarget('context')).toBe(true);
    expect(isTarget('inbox')).toBe(true);
    expect(isTarget('journal')).toBe(true);
  });
  it('rejects others', () => {
    expect(isTarget('foo')).toBe(false);
    expect(isTarget(null)).toBe(false);
    expect(isTarget(42)).toBe(false);
  });
});

describe('targetLabel', () => {
  it('null → kept here only', () => {
    expect(targetLabel(null)).toBe('kept here only');
    expect(targetLabel(undefined)).toBe('kept here only');
    expect(targetLabel('')).toBe('kept here only');
  });
  it('known target prefix', () => {
    expect(targetLabel('inbox')).toBe('→ inbox');
  });
  it('unknown passes through', () => {
    expect(targetLabel('weird')).toBe('weird');
  });
});
