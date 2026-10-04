import { describe, expect, it } from 'vitest';
import {
  isRecognisedKey,
  payloadKeyLabel,
  previewValue,
  restoreCountLabel,
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

describe('isRecognisedKey', () => {
  it('returns true for the curated set', () => {
    for (const k of ['cwd', 'branch', 'files', 'tabs', 'processes', 'terminals']) {
      expect(isRecognisedKey(k)).toBe(true);
    }
  });
  it('returns false for everything else', () => {
    expect(isRecognisedKey('foo')).toBe(false);
    expect(isRecognisedKey('')).toBe(false);
    expect(isRecognisedKey('git_status')).toBe(false);
  });
});

describe('payloadKeyLabel', () => {
  it('uses the curated heading for recognised keys', () => {
    expect(payloadKeyLabel('cwd')).toBe('Working directory');
    expect(payloadKeyLabel('branch')).toBe('Git branch');
    expect(payloadKeyLabel('files')).toBe('Recent files');
    expect(payloadKeyLabel('tabs')).toBe('Browser tabs');
    expect(payloadKeyLabel('processes')).toBe('Processes');
    expect(payloadKeyLabel('terminals')).toBe('Terminals');
  });
  it('title-cases snake_case keys', () => {
    expect(payloadKeyLabel('git_status')).toBe('Git Status');
  });
  it('title-cases kebab-case keys', () => {
    expect(payloadKeyLabel('open-tabs')).toBe('Open Tabs');
  });
  it('title-cases camelCase keys', () => {
    expect(payloadKeyLabel('openTabs')).toBe('Open Tabs');
  });
  it('returns the original key when there is no letter content', () => {
    expect(payloadKeyLabel('_')).toBe('_');
  });
});

describe('previewValue', () => {
  it('passes strings through', () => {
    expect(previewValue('hello')).toBe('hello');
  });
  it('stringifies numbers + booleans', () => {
    expect(previewValue(42)).toBe('42');
    expect(previewValue(true)).toBe('true');
  });
  it('returns "" for null / undefined', () => {
    expect(previewValue(null)).toBe('');
    expect(previewValue(undefined)).toBe('');
  });
  it('renders "(empty)" for an empty array', () => {
    expect(previewValue([])).toBe('(empty)');
  });
  it('lists the first 3 array items', () => {
    expect(previewValue(['a', 'b', 'c'])).toBe('a, b, c');
  });
  it('appends "… (+N more)" past 3 items', () => {
    expect(previewValue(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c, … (+2 more)');
  });
  it('JSON-stringifies a plain object', () => {
    expect(previewValue({ a: 1 })).toBe('{"a":1}');
  });
});

describe('restoreCountLabel', () => {
  it('returns "never restored" for 0 / negative / NaN', () => {
    expect(restoreCountLabel(0)).toBe('never restored');
    expect(restoreCountLabel(-1)).toBe('never restored');
    expect(restoreCountLabel(Number.NaN)).toBe('never restored');
  });
  it('singularises 1', () => {
    expect(restoreCountLabel(1)).toBe('1 restore');
  });
  it('pluralises >= 2', () => {
    expect(restoreCountLabel(5)).toBe('5 restores');
  });
});
