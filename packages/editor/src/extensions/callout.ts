import { Node, mergeAttributes } from '@tiptap/core';

export interface CalloutOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    callout: {
      /** Wrap the current block(s) in a callout. */
      setCallout: (attrs?: { emoji?: string; color?: string }) => ReturnType;
      /** Remove the surrounding callout, lifting its content. */
      toggleCallout: (attrs?: { emoji?: string; color?: string }) => ReturnType;
    };
  }
}

/**
 * Callout — a coloured block with a leading emoji that holds block content
 * (paragraphs, lists, …). Serialises to a `<div data-type="callout">` so it
 * round-trips through the HTML snapshot the page stores.
 */
export const Callout = Node.create<CalloutOptions>({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      emoji: {
        default: '💡',
        parseHTML: (el) => el.getAttribute('data-emoji') ?? '💡',
        renderHTML: (attrs) => ({ 'data-emoji': attrs.emoji as string }),
      },
      color: {
        default: '#fef9c3',
        parseHTML: (el) => el.getAttribute('data-color') ?? '#fef9c3',
        renderHTML: (attrs) => ({
          'data-color': attrs.color as string,
          style: `background-color:${attrs.color as string}`,
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="callout"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-type': 'callout',
        'data-testid': 'callout',
        class: 'ae-callout',
      }),
      ['span', { class: 'ae-callout-emoji', contenteditable: 'false' }, HTMLAttributes['data-emoji'] as string ?? '💡'],
      ['div', { class: 'ae-callout-body' }, 0],
    ];
  },

  addCommands() {
    return {
      setCallout:
        (attrs) =>
        ({ commands }) =>
          commands.wrapIn(this.name, attrs),
      toggleCallout:
        (attrs) =>
        ({ commands }) =>
          commands.toggleWrap(this.name, attrs),
    };
  },
});
