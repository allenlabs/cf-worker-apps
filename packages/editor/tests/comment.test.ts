import { describe, expect, it } from 'vitest';
import { Comment, commentThreadIdAt } from '../src/extensions/comment';

/** Minimal doc-like stub: nodeAt returns a node carrying the given marks. */
function docWith(marks: { type: { name: string }; attrs: Record<string, unknown> }[]) {
  return {
    nodeAt: (_pos: number) =>
      marks.length ? { marks } : { marks: [] as typeof marks },
  };
}

describe('Comment mark', () => {
  it('is an inline, non-inclusive mark named "comment"', () => {
    expect(Comment.name).toBe('comment');
    // inclusive:false keeps typing at the edge from extending the highlight.
    expect(Comment.config.inclusive).toBe(false);
  });

  it('exposes set/unset thread commands', () => {
    const cmds = Comment.config.addCommands?.call({
      name: 'comment',
    } as never);
    expect(cmds && typeof cmds.setCommentThread).toBe('function');
    expect(cmds && typeof cmds.unsetCommentThread).toBe('function');
  });
});

describe('commentThreadIdAt', () => {
  it('returns the threadId of a comment mark at the position', () => {
    const doc = docWith([{ type: { name: 'comment' }, attrs: { threadId: 't-1' } }]);
    expect(commentThreadIdAt(doc, 3)).toBe('t-1');
  });

  it('ignores non-comment marks', () => {
    const doc = docWith([{ type: { name: 'bold' }, attrs: {} }]);
    expect(commentThreadIdAt(doc, 1)).toBeNull();
  });

  it('returns null when no node sits at the position', () => {
    expect(commentThreadIdAt({ nodeAt: () => null }, 99)).toBeNull();
  });

  it('returns null when the comment mark has no string threadId', () => {
    const doc = docWith([{ type: { name: 'comment' }, attrs: { threadId: null } }]);
    expect(commentThreadIdAt(doc, 0)).toBeNull();
  });
});
