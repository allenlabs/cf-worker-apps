import { Mark, mergeAttributes } from '@tiptap/core';

export interface CommentOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    comment: {
      /** Anchor a comment thread to the current selection. */
      setCommentThread: (threadId: string) => ReturnType;
      /** Remove the comment mark for `threadId` across the whole doc (resolve). */
      unsetCommentThread: (threadId: string) => ReturnType;
    };
  }
}

/**
 * Comment — an inline mark that anchors a comment thread to a text range. The
 * `threadId` attribute keys into the Postgres-backed thread; the mark itself
 * lives in the doc and so syncs to every collaborator through the Yjs
 * Collaboration extension (it's a normal ProseMirror mark).
 *
 * Serialises to `<span class="ae-comment" data-thread-id="…">` so it round-trips
 * through the HTML snapshot the page stores.
 *
 * `inclusive: false` — typing at either edge of a commented span does NOT extend
 * the highlight, matching how anchored comments behave in Notion/Docs.
 */
export const Comment = Mark.create<CommentOptions>({
  name: 'comment',
  inclusive: false,
  // Comments can overlap other comments (and any other mark).
  excludes: '',

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-thread-id'),
        renderHTML: (attrs) =>
          attrs.threadId ? { 'data-thread-id': attrs.threadId as string } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-thread-id]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: 'ae-comment' }),
      0,
    ];
  },

  addCommands() {
    return {
      setCommentThread:
        (threadId) =>
        ({ commands }) =>
          commands.setMark(this.name, { threadId }),
      unsetCommentThread:
        (threadId) =>
        ({ tr, state, dispatch }) => {
          const markType = state.schema.marks[this.name];
          if (!markType) return false;
          const ranges: { from: number; to: number }[] = [];
          state.doc.descendants((node, pos) => {
            if (!node.isText) return;
            const has = node.marks.find(
              (m) => m.type === markType && m.attrs.threadId === threadId,
            );
            if (has) ranges.push({ from: pos, to: pos + node.nodeSize });
          });
          if (ranges.length === 0) return false;
          if (dispatch) {
            for (const r of ranges) tr.removeMark(r.from, r.to, markType);
          }
          return true;
        },
    };
  },
});

/**
 * The threadId on the comment mark at a document position, or null. Pure helper
 * so the click handler (and tests) can read the anchor without a live editor.
 */
export function commentThreadIdAt(
  doc: { nodeAt: (pos: number) => { marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[] } | null },
  pos: number,
): string | null {
  const node = doc.nodeAt(pos);
  if (!node) return null;
  const mark = node.marks.find((m) => m.type.name === 'comment');
  const id = mark?.attrs.threadId;
  return typeof id === 'string' ? id : null;
}
