import { describe, expect, it } from 'vitest';
import {
  BG_COLORS,
  DEFAULT_BLOCK_LABELS,
  TEXT_COLORS,
  TURN_INTO_TARGETS,
  colorBlock,
  deleteBlock,
  duplicateBlock,
  insertParagraphBelow,
  topLevelBlockAt,
  turnBlockInto,
} from '../src/lib/block-actions';
import type { Editor } from '@tiptap/core';
import { TODO_INPUT_REGEX } from '../src/extensions/markdown-rules';

/**
 * A chainable mock that records every command name it sees and reports the run
 * tail as `true`. Each method returns the same proxy so `editor.chain().focus()
 * .setParagraph().run()` works and we can assert the call sequence.
 */
function makeChain(calls: string[]) {
  const proxy: Record<string, (...a: unknown[]) => unknown> = {};
  const handler = new Proxy(proxy, {
    get(_t, prop: string) {
      if (prop === 'run') return () => true;
      return (...args: unknown[]) => {
        calls.push(args.length ? `${prop}(${JSON.stringify(args[0])})` : prop);
        return handler;
      };
    },
  });
  return handler;
}

/**
 * A fake editor whose doc is a flat sequence of top-level blocks. We model just
 * enough of ProseMirror's position API for topLevelBlockAt: depth-1 resolution
 * with `before`, `node`, `nodeAfter`, and `content.size`.
 */
function fakeEditor(opts?: { blockFrom?: number; blockSize?: number; nodeJSON?: unknown }) {
  const calls: string[] = [];
  const from = opts?.blockFrom ?? 0;
  const size = opts?.blockSize ?? 10;
  const nodeAfter = { toJSON: () => opts?.nodeJSON ?? { type: 'paragraph' } };
  const docSize = 100;
  const resolve = (pos: number) => ({
    depth: 1,
    node: () => ({ nodeSize: size }),
    before: () => from,
    nodeAfter,
    parent: { type: { name: 'paragraph' } },
  });
  const editor = {
    isEditable: true,
    state: {
      doc: { content: { size: docSize }, resolve },
    },
    chain: () => makeChain(calls),
  } as unknown as Editor;
  return { editor, calls };
}

describe('TURN_INTO_TARGETS / labels', () => {
  it('exposes the Notion block set with unique ids and an English label each', () => {
    const ids = TURN_INTO_TARGETS.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining(['paragraph', 'h1', 'h2', 'h3', 'taskList', 'callout', 'toggle']),
    );
    for (const t of TURN_INTO_TARGETS) {
      expect(DEFAULT_BLOCK_LABELS[t.labelKey]).toBeTypeOf('string');
    }
  });

  it('ships text + background color palettes', () => {
    expect(TEXT_COLORS.length).toBeGreaterThan(3);
    expect(BG_COLORS.every((c) => typeof c.bgColor === 'string')).toBe(true);
  });
});

describe('topLevelBlockAt', () => {
  it('resolves a block range from a position, clamping out-of-range input', () => {
    const { editor } = fakeEditor({ blockFrom: 4, blockSize: 6 });
    const block = topLevelBlockAt(editor, 999);
    expect(block).toEqual({ from: 4, to: 10, pos: 4 });
  });
});

describe('turnBlockInto', () => {
  it('clears nodes + sets a heading for h2', () => {
    const { editor, calls } = fakeEditor();
    expect(turnBlockInto(editor, 0, 'h2')).toBe(true);
    expect(calls).toContain('clearNodes');
    expect(calls.some((c) => c.startsWith('setNode('))).toBe(true);
  });

  it('toggles the task list for taskList', () => {
    const { editor, calls } = fakeEditor();
    expect(turnBlockInto(editor, 0, 'taskList')).toBe(true);
    expect(calls).toContain('toggleTaskList');
  });

  it('wraps in a callout for callout', () => {
    const { editor, calls } = fakeEditor();
    expect(turnBlockInto(editor, 0, 'callout')).toBe(true);
    expect(calls).toContain('setCallout');
  });
});

describe('duplicateBlock', () => {
  it('inserts the cloned node JSON at the end of the block', () => {
    const { editor, calls } = fakeEditor({ blockFrom: 0, blockSize: 8, nodeJSON: { type: 'paragraph' } });
    expect(duplicateBlock(editor, 0)).toBe(true);
    expect(calls.some((c) => c.startsWith('insertContentAt('))).toBe(true);
  });
});

describe('deleteBlock', () => {
  it('deletes the resolved block range', () => {
    const { editor, calls } = fakeEditor({ blockFrom: 2, blockSize: 5 });
    expect(deleteBlock(editor, 3)).toBe(true);
    expect(calls.some((c) => c.startsWith('deleteRange('))).toBe(true);
  });
});

describe('colorBlock', () => {
  it('sets a text color for a text-color choice', () => {
    const { editor, calls } = fakeEditor();
    expect(colorBlock(editor, 0, { id: 'red', labelKey: 'color.red', textColor: '#dc2626' })).toBe(true);
    expect(calls.some((c) => c.startsWith('setColor('))).toBe(true);
  });

  it('unsets the color for the default (null) choice', () => {
    const { editor, calls } = fakeEditor();
    expect(colorBlock(editor, 0, { id: 'default', labelKey: 'block.colorDefault', textColor: null })).toBe(true);
    expect(calls).toContain('unsetColor');
  });

  it('wraps in a tinted callout for a background choice', () => {
    const { editor, calls } = fakeEditor();
    expect(colorBlock(editor, 0, { id: 'bg-yellow', labelKey: 'color.bgYellow', bgColor: '#fef9c3' })).toBe(true);
    expect(calls.some((c) => c.startsWith('setCallout('))).toBe(true);
  });
});

describe('insertParagraphBelow', () => {
  it('inserts a paragraph after the block and returns the caret pos', () => {
    const { editor, calls } = fakeEditor({ blockFrom: 0, blockSize: 4 });
    const caret = insertParagraphBelow(editor, 0);
    expect(caret).toBe(5); // to(4) + 1
    expect(calls.some((c) => c.includes('insertContentAt'))).toBe(true);
  });
});

describe('TODO_INPUT_REGEX', () => {
  it('matches the to-do markdown prefixes', () => {
    expect('[] '.match(TODO_INPUT_REGEX)).not.toBeNull();
    expect('[ ] '.match(TODO_INPUT_REGEX)).not.toBeNull();
    expect('[x] '.match(TODO_INPUT_REGEX)).not.toBeNull();
    expect('[X] '.match(TODO_INPUT_REGEX)).not.toBeNull();
  });

  it('captures the checked state', () => {
    expect('[x] '.match(TODO_INPUT_REGEX)![1]).toBe('x');
    expect('[ ] '.match(TODO_INPUT_REGEX)![1]).toBe(' ');
  });

  it('does not match a non-todo bracket', () => {
    expect('[link] '.match(TODO_INPUT_REGEX)).toBeNull();
    expect('no brackets '.match(TODO_INPUT_REGEX)).toBeNull();
  });
});
