import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    toggle: {
      /** Insert an empty collapsible toggle and place the caret in its body. */
      setToggle: () => ReturnType;
    };
  }
}

/**
 * Toggle summary — the always-visible disclosure line of a {@link Toggle}.
 * A plain inline-content block; the clickable triangle lives in the parent's
 * NodeView so it can flip the parent's `open` attribute.
 */
export const ToggleSummary = Node.create({
  name: 'toggleSummary',
  content: 'inline*',
  defining: true,
  selectable: false,
  parseHTML() {
    return [{ tag: 'summary[data-type="toggle-summary"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'summary',
      mergeAttributes(HTMLAttributes, { 'data-type': 'toggle-summary', class: 'ae-toggle-summary' }),
      0,
    ];
  },
});

/**
 * Toggle — a `<details>`-like collapsible. First child is a
 * {@link ToggleSummary} (the disclosure line); the rest is hidden block
 * content. A NodeView draws a clickable ▸/▾ triangle that flips `open`.
 *
 * Round-trips as `<details data-type="toggle" open>` so the HTML snapshot keeps
 * the open/closed state.
 */
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'toggleSummary block*',
  defining: true,

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el) => el.hasAttribute('open'),
        renderHTML: (attrs) => (attrs.open ? { open: 'open' } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'details[data-type="toggle"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'details',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'toggle',
        'data-testid': 'toggle',
        class: 'ae-toggle',
      }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'ae-toggle';
      dom.setAttribute('data-type', 'toggle');
      dom.setAttribute('data-testid', 'toggle');
      dom.dataset.open = String(node.attrs.open);

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ae-toggle-caret';
      button.contentEditable = 'false';
      button.setAttribute('aria-label', 'Toggle');
      button.textContent = node.attrs.open ? '▾' : '▸';
      button.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (pos == null) return;
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeAttribute(pos, 'open', !node.attrs.open);
            return true;
          })
          .run();
      });

      const content = document.createElement('div');
      content.className = 'ae-toggle-content';

      dom.appendChild(button);
      dom.appendChild(content);

      return {
        dom,
        contentDOM: content,
        update: (updated) => {
          if (updated.type.name !== 'toggle') return false;
          dom.dataset.open = String(updated.attrs.open);
          button.textContent = updated.attrs.open ? '▾' : '▸';
          return true;
        },
      };
    };
  },

  addCommands() {
    return {
      setToggle:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { open: true },
            content: [
              { type: 'toggleSummary', content: [{ type: 'text', text: 'Toggle' }] },
              { type: 'paragraph' },
            ],
          }),
    };
  },
});
