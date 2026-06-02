import { describe, expect, it, vi } from 'vitest';
import { childPageLabel, CHILD_PAGE_DEFAULT_ICON } from '../src/extensions/child-page';
import { makeChildPageSlashItem } from '../src/lib/slash-items';

describe('childPageLabel', () => {
  it('returns the trimmed title when present', () => {
    expect(childPageLabel('  Roadmap  ')).toBe('Roadmap');
  });

  it('falls back to "Untitled" for blank/missing titles', () => {
    expect(childPageLabel('')).toBe('Untitled');
    expect(childPageLabel('   ')).toBe('Untitled');
    expect(childPageLabel(null)).toBe('Untitled');
    expect(childPageLabel(undefined)).toBe('Untitled');
  });
});

describe('CHILD_PAGE_DEFAULT_ICON', () => {
  it('is the document emoji', () => {
    expect(CHILD_PAGE_DEFAULT_ICON).toBe('📄');
  });
});

/**
 * A tiny editor chain stub: records the calls and lets us assert that the
 * "Page" item deletes the slash range and inserts the returned child page.
 */
function makeEditorStub(lineText: string) {
  const calls: string[] = [];
  const inserted: { pageId: string; title: string; icon?: string }[] = [];
  const chain = {
    focus: () => chain,
    deleteRange: (_r: unknown) => {
      calls.push('deleteRange');
      return chain;
    },
    setChildPage: (attrs: { pageId: string; title: string; icon?: string }) => {
      inserted.push(attrs);
      return chain;
    },
    run: () => true,
  };
  const editor = {
    chain: () => chain,
    state: { doc: { textBetween: () => lineText } },
  };
  return { editor, calls, inserted };
}

describe('makeChildPageSlashItem', () => {
  it('builds a "Page" item with sub-page keywords', () => {
    const item = makeChildPageSlashItem(async () => ({ id: 'x', title: 'X' }));
    expect(item.title).toBe('Page');
    expect(item.keywords).toContain('sub-page');
    expect(typeof item.command).toBe('function');
  });

  it('seeds the title from the current line and inserts the created page', async () => {
    const onCreate = vi
      .fn()
      .mockResolvedValue({ id: 'p-9', title: 'My Plan', icon: '🗒' });
    const item = makeChildPageSlashItem(onCreate);
    const { editor, calls, inserted } = makeEditorStub('/My Plan');

    item.command({ editor: editor as never, range: { from: 1, to: 8 } as never });
    // The slash range is deleted synchronously, before the async create resolves.
    expect(calls).toContain('deleteRange');
    await Promise.resolve();
    await Promise.resolve();

    expect(onCreate).toHaveBeenCalledWith('My Plan');
    expect(inserted).toEqual([{ pageId: 'p-9', title: 'My Plan', icon: '🗒' }]);
  });

  it('uses "Untitled" as the seed when the line is blank', async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: 'p-1', title: 'Untitled' });
    const item = makeChildPageSlashItem(onCreate);
    const { editor } = makeEditorStub('/');

    item.command({ editor: editor as never, range: { from: 1, to: 2 } as never });
    await Promise.resolve();
    expect(onCreate).toHaveBeenCalledWith('Untitled');
  });
});
