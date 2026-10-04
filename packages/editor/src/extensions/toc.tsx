import { Node, mergeAttributes, ReactNodeViewRenderer, NodeViewWrapper } from '@tiptap/react';
import type { NodeViewProps } from '@tiptap/react';
import { useEffect, useState } from 'react';
import { collectHeadings } from './heading-id';
import type { TocEntry } from '../lib/headings';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tableOfContents: {
      /** Insert a live table-of-contents block. */
      setTableOfContents: () => ReturnType;
    };
  }
}

/**
 * TOC NodeView. Subscribes to editor updates and re-reads the doc's headings
 * (levels 1–3) so the outline stays live as headings are added/edited/removed.
 * Clicking an entry scrolls its heading (matched by `id`) into view.
 */
function TableOfContentsView(props: NodeViewProps) {
  const { editor } = props;
  const [entries, setEntries] = useState<TocEntry[]>(() => collectHeadings(editor.state.doc));

  useEffect(() => {
    const update = () => setEntries(collectHeadings(editor.state.doc));
    update();
    editor.on('update', update);
    return () => {
      editor.off('update', update);
    };
  }, [editor]);

  function scrollTo(id: string) {
    if (!id || typeof document === 'undefined') return;
    const root = editor.view.dom as HTMLElement;
    const el = (root.querySelector(`#${CSS.escape(id)}`) ??
      document.getElementById(id)) as HTMLElement | null;
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  const minLevel = entries.reduce((m, e) => Math.min(m, e.level), 3);

  return (
    <NodeViewWrapper
      className="ae-toc"
      data-type="table-of-contents"
      data-testid="table-of-contents"
      contentEditable={false}
    >
      {entries.length === 0 ? (
        <p className="ae-toc-empty">No headings yet.</p>
      ) : (
        <ul className="ae-toc-list">
          {entries.map((e, i) => (
            <li
              key={`${e.id}-${i}`}
              className="ae-toc-item"
              style={{ paddingLeft: `${(e.level - minLevel) * 1}rem` }}
            >
              <button
                type="button"
                className="ae-toc-link"
                data-level={e.level}
                onClick={() => scrollTo(e.id)}
              >
                {e.text || 'Untitled heading'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </NodeViewWrapper>
  );
}

/**
 * TableOfContents — an atom block that renders a live, clickable outline of the
 * page's headings (h1–h3). It reads headings from the doc on every update (so it
 * never goes stale) and scrolls to a heading via its stable `id` (assigned by
 * the HeadingId extension). Stores no content; serialises to
 * `<div data-type="table-of-contents">`. An atom → no recursion risk.
 */
export const TableOfContents = Node.create({
  name: 'tableOfContents',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  parseHTML() {
    return [{ tag: 'div[data-type="table-of-contents"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'table-of-contents',
        'data-testid': 'table-of-contents',
        class: 'ae-toc',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(TableOfContentsView);
  },

  addCommands() {
    return {
      setTableOfContents:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});
