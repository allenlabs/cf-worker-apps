import { describe, expect, it } from 'vitest';
import { syncRoom } from '../src/extensions/synced-block';
import { makeSyncedBlockSlashItem } from '../src/lib/slash-items';

describe('syncRoom', () => {
  it('prefixes the sync id with "sync-"', () => {
    expect(syncRoom('abc')).toBe('sync-abc');
  });

  it('round-trips a UUID-shaped id without mangling it', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(syncRoom(id)).toBe(`sync-${id}`);
  });

  it('is stable for the same id (so every instance binds the same room)', () => {
    expect(syncRoom('x')).toBe(syncRoom('x'));
  });
});

/**
 * Editor chain stub recording the calls so we can assert the slash command
 * deletes the typed range then inserts a synced block (the node's command
 * supplies a fresh syncId).
 */
function makeEditorStub() {
  const calls: string[] = [];
  const chain = {
    focus: () => chain,
    deleteRange: () => {
      calls.push('deleteRange');
      return chain;
    },
    setSyncedBlock: () => {
      calls.push('setSyncedBlock');
      return chain;
    },
    run: () => true,
  };
  return { editor: { chain: () => chain }, calls };
}

describe('makeSyncedBlockSlashItem', () => {
  it('defaults to English title/hint + sync keywords', () => {
    const item = makeSyncedBlockSlashItem();
    expect(item.title).toBe('Synced block');
    expect(item.hint).toBe('Content mirrored across pages');
    expect(item.keywords).toContain('mirror');
    expect(typeof item.command).toBe('function');
  });

  it('uses host-translated labels when provided', () => {
    const item = makeSyncedBlockSlashItem({ title: '동기화 블록', hint: '여러 페이지에 미러링' });
    expect(item.title).toBe('동기화 블록');
    expect(item.hint).toBe('여러 페이지에 미러링');
  });

  it('deletes the slash range then inserts the synced block', () => {
    const item = makeSyncedBlockSlashItem();
    const { editor, calls } = makeEditorStub();
    item.command({ editor: editor as never, range: { from: 1, to: 2 } as never });
    expect(calls).toEqual(['deleteRange', 'setSyncedBlock']);
  });
});
