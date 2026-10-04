import { describe, expect, it } from 'vitest';
import { isoNow, relativeAgo } from '~/lib/format';

describe('isoNow', () => {
  it('returns ISO string', () => {
    expect(isoNow(new Date('2026-05-24T10:00:00Z'))).toBe('2026-05-24T10:00:00.000Z');
  });
  it('defaults to now', () => {
    expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('relativeAgo', () => {
  const now = new Date('2026-05-24T12:00:00Z');
  it('null/undefined → never', () => {
    expect(relativeAgo(null, now)).toBe('never');
    expect(relativeAgo(undefined, now)).toBe('never');
  });
  it('empty string → never', () => {
    expect(relativeAgo('', now)).toBe('never');
  });
  it('malformed → never', () => {
    expect(relativeAgo('not-a-date', now)).toBe('never');
  });
  it('seconds', () => {
    const t = new Date(now.getTime() - 30_000).toISOString();
    expect(relativeAgo(t, now)).toBe('30s ago');
  });
  it('minutes', () => {
    const t = new Date(now.getTime() - 5 * 60_000).toISOString();
    expect(relativeAgo(t, now)).toBe('5m ago');
  });
  it('hours', () => {
    const t = new Date(now.getTime() - 3 * 3600_000).toISOString();
    expect(relativeAgo(t, now)).toBe('3h ago');
  });
  it('days', () => {
    const t = new Date(now.getTime() - 2 * 86400_000).toISOString();
    expect(relativeAgo(t, now)).toBe('2d ago');
  });
  it('future clamps to 0s', () => {
    const t = new Date(now.getTime() + 5_000).toISOString();
    expect(relativeAgo(t, now)).toBe('0s ago');
  });
});
