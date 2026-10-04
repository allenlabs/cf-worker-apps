import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    columns: {
      /** Insert a 2-column layout, caret in the first column. */
      setColumns: () => ReturnType;
    };
  }
}

/** A single column inside a {@link Columns} layout. Holds block content. */
export const Column = Node.create({
  name: 'column',
  content: 'block+',
  isolating: true,
  parseHTML() {
    return [{ tag: 'div[data-type="column"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'column', class: 'ae-column' }),
      0,
    ];
  },
});

/**
 * Columns — a flex row of {@link Column}s. Kept deliberately simple (fixed
 * 2-up on insert); the underlying schema allows any number of columns so the
 * layout survives a richer editor later.
 */
export const Columns = Node.create({
  name: 'columns',
  group: 'block',
  content: 'column{2,}',
  parseHTML() {
    return [{ tag: 'div[data-type="columns"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'columns',
        'data-testid': 'columns',
        class: 'ae-columns',
      }),
      0,
    ];
  },
  addCommands() {
    return {
      setColumns:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            content: [
              { type: 'column', content: [{ type: 'paragraph' }] },
              { type: 'column', content: [{ type: 'paragraph' }] },
            ],
          }),
    };
  },
});
