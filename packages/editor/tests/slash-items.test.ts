import { describe, expect, it } from 'vitest';
import { DEFAULT_SLASH_ITEMS, filterSlashItems } from '../src/lib/slash-items';

describe('DEFAULT_SLASH_ITEMS', () => {
  it('covers the core block set with unique titles + commands', () => {
    const titles = DEFAULT_SLASH_ITEMS.map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(['Heading 1', 'To-do list', 'Code block']));
    expect(new Set(titles).size).toBe(titles.length); // unique
    for (const it of DEFAULT_SLASH_ITEMS) expect(typeof it.command).toBe('function');
  });

  it('includes the Phase 2 rich blocks', () => {
    const titles = DEFAULT_SLASH_ITEMS.map((i) => i.title);
    expect(titles).toEqual(
      expect.arrayContaining(['Callout', 'Toggle', 'Image', 'Table', 'Columns', 'Bookmark']),
    );
  });
});

describe('filterSlashItems', () => {
  it('returns all items for an empty query', () => {
    expect(filterSlashItems(DEFAULT_SLASH_ITEMS, '')).toHaveLength(DEFAULT_SLASH_ITEMS.length);
    expect(filterSlashItems(DEFAULT_SLASH_ITEMS, '   ')).toHaveLength(DEFAULT_SLASH_ITEMS.length);
  });

  it('matches on title (case-insensitive)', () => {
    const r = filterSlashItems(DEFAULT_SLASH_ITEMS, 'HEAD');
    expect(r.length).toBe(3);
    expect(r.every((i) => i.title.startsWith('Heading'))).toBe(true);
  });

  it('matches on keywords', () => {
    const r = filterSlashItems(DEFAULT_SLASH_ITEMS, 'checkbox');
    expect(r).toHaveLength(1);
    expect(r[0]!.title).toBe('To-do list');
  });

  it('returns nothing for a non-match', () => {
    expect(filterSlashItems(DEFAULT_SLASH_ITEMS, 'zzz-nope')).toHaveLength(0);
  });
});
