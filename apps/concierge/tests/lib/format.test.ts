import { describe, expect, it } from 'vitest';
import {
  timeAgo,
  topicLabel,
  inFuture,
  minutesToHHMM,
  hhmmToMinutes,
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

describe('topicLabel', () => {
  it('renders friendly labels for known topics', () => {
    expect(topicLabel('inbox-idle')).toBe('Inbox idle');
    expect(topicLabel('focus-abandoned')).toBe('Focus abandoned');
    expect(topicLabel('pm-stalled')).toBe('PM stalled');
    expect(topicLabel('celebration')).toBe('Celebration');
    expect(topicLabel('open-thread')).toBe('Open thread');
    expect(topicLabel('event')).toBe('Cross-app event');
  });
  it('passes unknown slugs through', () => {
    expect(topicLabel('mystery')).toBe('mystery');
  });
});

describe('inFuture', () => {
  it('returns "now" for non-positive durations', () => {
    expect(inFuture(0)).toBe('now');
    expect(inFuture(-5)).toBe('now');
    expect(inFuture(NaN)).toBe('now');
  });
  it('returns "in Nm" for sub-hour', () => {
    expect(inFuture(15 * 60_000)).toBe('in 15m');
  });
  it('returns "in Nh" for whole hours', () => {
    expect(inFuture(2 * 3600_000)).toBe('in 2h');
  });
  it('returns "in Nh Mm" for mixed', () => {
    expect(inFuture(2 * 3600_000 + 30 * 60_000)).toBe('in 2h 30m');
  });
});

describe('minutesToHHMM / hhmmToMinutes', () => {
  it('round-trips', () => {
    expect(minutesToHHMM(0)).toBe('00:00');
    expect(minutesToHHMM(22 * 60 + 30)).toBe('22:30');
    expect(hhmmToMinutes('22:30')).toBe(22 * 60 + 30);
    expect(hhmmToMinutes('00:00')).toBe(0);
  });
  it('returns empty / null for out-of-range', () => {
    expect(minutesToHHMM(null)).toBe('');
    expect(minutesToHHMM(undefined)).toBe('');
    expect(minutesToHHMM(NaN)).toBe('');
    expect(minutesToHHMM(-1)).toBe('');
    expect(minutesToHHMM(1440)).toBe('');
  });
  it('rejects malformed strings', () => {
    expect(hhmmToMinutes('')).toBeNull();
    expect(hhmmToMinutes('25:00')).toBeNull();
    expect(hhmmToMinutes('22:60')).toBeNull();
    expect(hhmmToMinutes('abc')).toBeNull();
  });
});
