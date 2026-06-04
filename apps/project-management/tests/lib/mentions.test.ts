import { describe, expect, it } from 'vitest';
import { parseMentions } from '~/lib/mentions';

describe('parseMentions', () => {
  it('extracts unique lowercased handles', () => {
    expect(parseMentions('hey @alice and @Bob, also @alice again')).toEqual(['alice', 'bob']);
  });

  it('supports dots, underscores, hyphens, digits', () => {
    expect(parseMentions('@allen.lim @bob_2 @c-3')).toEqual(['allen.lim', 'bob_2', 'c-3']);
  });

  it('returns [] for no mentions or empty input', () => {
    expect(parseMentions('nothing here')).toEqual([]);
    expect(parseMentions('')).toEqual([]);
    expect(parseMentions(null)).toEqual([]);
    expect(parseMentions(undefined)).toEqual([]);
  });
});
