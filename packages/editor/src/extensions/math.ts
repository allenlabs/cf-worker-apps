import { InputRule } from '@tiptap/core';
import { Node, mergeAttributes, ReactNodeViewRenderer } from '@tiptap/react';
import { InlineMathView, MathBlockView } from './math-view';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    inlineMath: {
      /** Insert an inline math node with the given LaTeX. */
      setInlineMath: (attrs: { latex: string }) => ReturnType;
    };
    mathBlock: {
      /** Insert a block (display) math node, optionally pre-seeded with LaTeX. */
      setMathBlock: (attrs?: { latex?: string }) => ReturnType;
    };
  }
}

/** `$…$` inline-math input rule (single `$` pair, no nested `$`). */
export const INLINE_MATH_INPUT_REGEX = /\$([^$]+)\$$/;

/**
 * InlineMath — an inline atom storing a `latex` string, rendered via KaTeX.
 * Typing `$x^2$` turns into an inline equation; serialises to
 * `<span data-type="inline-math" data-latex="…">` so it round-trips through the
 * HTML snapshot. Render errors show in red (KaTeX `throwOnError:false`) rather
 * than crashing the editor.
 */
export const InlineMath = Node.create({
  name: 'inlineMath',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-type="inline-math"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'inline-math',
        'data-testid': 'inline-math',
        class: 'ae-inline-math',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(InlineMathView);
  },

  addInputRules() {
    return [
      new InputRule({
        find: INLINE_MATH_INPUT_REGEX,
        handler: ({ range, match, chain }) => {
          const latex = (match[1] ?? '').trim();
          if (!latex) return null;
          chain()
            .deleteRange(range)
            .insertContent({ type: this.name, attrs: { latex } })
            .run();
        },
      }),
    ];
  },

  addCommands() {
    return {
      setInlineMath:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});

/**
 * MathBlock — a display-math atom block storing `latex`. A React NodeView
 * renders the KaTeX output and reveals an editable textarea on click; slash
 * "Equation" inserts an empty one. Serialises to
 * `<div data-type="math-block" data-latex="…">` for HTML round-trip.
 */
export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      latex: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-latex') ?? el.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-latex': attrs.latex as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="math-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'math-block',
        'data-testid': 'math-block',
        class: 'ae-math-block',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(MathBlockView);
  },

  addCommands() {
    return {
      setMathBlock:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs: { latex: attrs?.latex ?? '' } }),
    };
  },
});
