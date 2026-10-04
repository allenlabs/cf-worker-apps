import { describe, expect, it, vi } from 'vitest';
import {
  linkedDatabaseLabel,
  LINKED_DATABASE_ICON,
} from '../src/extensions/linked-database';
import { makeLinkedDatabaseSlashItem } from '../src/lib/slash-items';

describe('linkedDatabaseLabel', () => {
  it('returns the trimmed title when present', () => {
    expect(linkedDatabaseLabel('  Tasks  ')).toBe('Tasks');
  });

  it('falls back to "Untitled database" for blank/missing titles', () => {
    expect(linkedDatabaseLabel('')).toBe('Untitled database');
    expect(linkedDatabaseLabel('   ')).toBe('Untitled database');
    expect(linkedDatabaseLabel(null)).toBe('Untitled database');
    expect(linkedDatabaseLabel(undefined)).toBe('Untitled database');
  });
});

describe('LINKED_DATABASE_ICON', () => {
  it('is the link emoji', () => {
    expect(LINKED_DATABASE_ICON).toBe('🔗');
  });
});

/** Editor chain stub recording deleteRange + setLinkedDatabase calls. */
function makeEditorStub() {
  const calls: string[] = [];
  const inserted: { databaseId: string; title?: string; viewId?: string | null }[] = [];
  const chain = {
    focus: () => chain,
    deleteRange: (_r: unknown) => {
      calls.push('deleteRange');
      return chain;
    },
    setLinkedDatabase: (attrs: { databaseId: string; title?: string; viewId?: string | null }) => {
      inserted.push(attrs);
      return chain;
    },
    run: () => true,
  };
  return { editor: { chain: () => chain }, calls, inserted };
}

describe('makeLinkedDatabaseSlashItem', () => {
  it('builds a "Linked database view" item with db keywords', () => {
    const item = makeLinkedDatabaseSlashItem(async () => null);
    expect(item.title).toBe('Linked database view');
    expect(item.keywords).toContain('linked');
    expect(item.keywords).toContain('database');
    expect(typeof item.command).toBe('function');
  });

  it('honors host-translated title/hint', () => {
    const item = makeLinkedDatabaseSlashItem(async () => null, {
      title: '연결된 데이터베이스 뷰',
      hint: '기존 데이터베이스 임베드',
    });
    expect(item.title).toBe('연결된 데이터베이스 뷰');
    expect(item.hint).toBe('기존 데이터베이스 임베드');
  });

  it('deletes the slash range then inserts the picked database', async () => {
    const onPick = vi.fn().mockResolvedValue({ databaseId: 'db-1', title: 'Tasks', viewId: 'v-1' });
    const item = makeLinkedDatabaseSlashItem(onPick);
    const { editor, calls, inserted } = makeEditorStub();

    item.command({ editor: editor as never, range: { from: 1, to: 8 } as never });
    expect(calls).toContain('deleteRange');
    await Promise.resolve();
    await Promise.resolve();

    expect(onPick).toHaveBeenCalled();
    expect(inserted).toEqual([{ databaseId: 'db-1', title: 'Tasks', viewId: 'v-1' }]);
  });

  it('inserts nothing when the picker is cancelled (null)', async () => {
    const onPick = vi.fn().mockResolvedValue(null);
    const item = makeLinkedDatabaseSlashItem(onPick);
    const { editor, inserted } = makeEditorStub();

    item.command({ editor: editor as never, range: { from: 1, to: 2 } as never });
    await Promise.resolve();
    await Promise.resolve();

    expect(onPick).toHaveBeenCalled();
    expect(inserted).toEqual([]);
  });
});
