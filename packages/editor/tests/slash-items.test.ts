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

  it('includes the Phase 13 blocks (math/embed/media/toc/breadcrumb)', () => {
    const titles = DEFAULT_SLASH_ITEMS.map((i) => i.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        'Equation',
        'Embed',
        'Video',
        'Audio',
        'File',
        'Table of contents',
        'Breadcrumb',
      ]),
    );
  });

  it('gives every Phase 13 item an icon', () => {
    const phase13 = ['Equation', 'Embed', 'Video', 'Audio', 'File', 'Table of contents', 'Breadcrumb'];
    for (const title of phase13) {
      const item = DEFAULT_SLASH_ITEMS.find((i) => i.title === title);
      expect(item, title).toBeDefined();
      expect(item!.icon, title).toBeTruthy();
    }
  });
});

describe('filterSlashItems', () => {
  it('returns all items for an empty query', () => {
    expect(filterSlashItems(DEFAULT_SLASH_ITEMS, '')).toHaveLength(DEFAULT_SLASH_ITEMS.length);
    expect(filterSlashItems(DEFAULT_SLASH_ITEMS, '   ')).toHaveLength(DEFAULT_SLASH_ITEMS.length);
  });

  it('matches on title (case-insensitive)', () => {
    const r = filterSlashItems(DEFAULT_SLASH_ITEMS, 'HEADING');
    expect(r.filter((i) => i.title.startsWith('Heading'))).toHaveLength(3);
    // "heading" also appears as a keyword on the Table of contents item.
    expect(r.map((i) => i.title)).toContain('Table of contents');
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
