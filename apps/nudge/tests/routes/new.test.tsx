import { describe, expect, it } from 'vitest';
import { parseTags, parseWhen } from '~/routes/new';

describe('parseTags', () => {
  it('returns [] for empty input', () => {
    expect(parseTags('')).toEqual([]);
  });
  it('splits on spaces + commas', () => {
    expect(parseTags('a b, c')).toEqual(['a', 'b', 'c']);
  });
  it('strips leading #', () => {
    expect(parseTags('#a #b')).toEqual(['a', 'b']);
  });
  it('lowercases', () => {
    expect(parseTags('A B')).toEqual(['a', 'b']);
  });
  it('dedupes', () => {
    expect(parseTags('a a b a')).toEqual(['a', 'b']);
  });
});

describe('parseWhen', () => {
  it('null on empty', () => {
    expect(parseWhen('')).toBeNull();
  });
  it('parses "now"', () => {
    expect(parseWhen('now')).toEqual({ relativeSeconds: 1 });
  });
  it('parses "in 5m"', () => {
    expect(parseWhen('in 5m')).toEqual({ relativeSeconds: 300 });
  });
  it('parses "in 30s"', () => {
    expect(parseWhen('in 30s')).toEqual({ relativeSeconds: 30 });
  });
  it('parses "in 2h"', () => {
    expect(parseWhen('in 2h')).toEqual({ relativeSeconds: 7200 });
  });
  it('parses "in 1d"', () => {
    expect(parseWhen('in 1d')).toEqual({ relativeSeconds: 86400 });
  });
  it('parses "in 7 days"', () => {
    expect(parseWhen('in 7 days')).toEqual({ relativeSeconds: 7 * 86400 });
  });
  it('parses iso dates', () => {
    expect(parseWhen('2026-05-24T11:00:00Z')).toEqual({ fireAt: '2026-05-24T11:00:00.000Z' });
  });
  it('null on unparseable', () => {
    expect(parseWhen('asdf')).toBeNull();
  });
  it('null on negative relative', () => {
    expect(parseWhen('in 0m')).toBeNull();
  });
});
