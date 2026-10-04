import { mergeAttributes } from '@tiptap/core';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { createLowlight } from 'lowlight';
// highlight.js languages — registered individually (vs. `common`) so the bundle
// only carries the grammars we actually offer in the picker.
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import python from 'highlight.js/lib/languages/python';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import {
  CODE_LANGUAGES,
  DEFAULT_CODE_LANGUAGE,
  normalizeLanguage,
  languageLabel,
} from '../lib/code-languages';

/**
 * A lowlight instance registered with the common grammars we offer. `tsx`/`jsx`
 * reuse the typescript/javascript grammars (highlight.js has no distinct tsx
 * grammar; the JS/TS ones already handle JSX). Exported for tests.
 */
export function makeLowlight(): ReturnType<typeof createLowlight> {
  const lowlight = createLowlight();
  lowlight.register({ typescript, javascript, python, go, rust, json, bash, sql, xml, css, yaml, markdown });
  // Alias the React flavors onto their base grammars + register the HTML alias
  // so a ```html / ```tsx fence highlights.
  lowlight.registerAlias({ typescript: ['tsx', 'ts'], javascript: ['jsx', 'js'], xml: ['html'] });
  return lowlight;
}

/**
 * CodeBlock — StarterKit's plain code block swapped for CodeBlockLowlight, which
 * keeps the SAME node name (`codeBlock`) + storage so existing content upgrades
 * in place (the ```fence input rule + content survive). Adds:
 *  - syntax highlighting (lowlight → highlight.js token spans),
 *  - a language `<select>` dropdown (top-left chrome) + a Copy button,
 *  - canonical `language` normalization (ts → typescript, etc.).
 *
 * The NodeView is plain DOM (no React) so it stays light and SSR-safe; the host
 * already gates mount to the client. Read-only viewers get the highlight + Copy
 * but the language select is disabled.
 */
export const CodeBlock = CodeBlockLowlight.extend({
  addOptions() {
    return {
      ...this.parent?.(),
      // Self-contained lowlight instance (the package registers its own grammars)
      // so the host never has to wire one. StarterKit disables its own codeBlock
      // when we register this; the markdown ```fence keeps working via the
      // parent's input rules.
      lowlight: makeLowlight(),
      defaultLanguage: DEFAULT_CODE_LANGUAGE,
      HTMLAttributes: { class: 'ae-code-block' },
    };
  },

  renderHTML({ node, HTMLAttributes }) {
    const lang = normalizeLanguage(node.attrs.language as string | null);
    return [
      'pre',
      mergeAttributes(this.options.HTMLAttributes, { 'data-testid': 'code-block' }),
      ['code', { class: `language-${lang}` }, 0],
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'ae-code-block-wrap';
      dom.setAttribute('data-type', 'code-block');
      dom.setAttribute('data-testid', 'code-block');

      // Chrome row: language picker (left) + copy button (right). Marked
      // contenteditable=false so ProseMirror treats it as decoration.
      const chrome = document.createElement('div');
      chrome.className = 'ae-code-chrome';
      chrome.contentEditable = 'false';

      const select = document.createElement('select');
      select.className = 'ae-code-lang';
      select.setAttribute('aria-label', 'Code language');
      for (const lang of CODE_LANGUAGES) {
        const opt = document.createElement('option');
        opt.value = lang.id;
        opt.textContent = lang.label;
        select.appendChild(opt);
      }
      select.value = normalizeLanguage(node.attrs.language as string | null);
      select.disabled = !editor.isEditable;
      select.addEventListener('mousedown', (e) => e.stopPropagation());
      select.addEventListener('change', () => {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (pos == null) return;
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeAttribute(pos, 'language', select.value);
            return true;
          })
          .run();
      });

      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'ae-code-copy';
      copy.contentEditable = 'false';
      copy.textContent = 'Copy';
      copy.setAttribute('aria-label', 'Copy code');
      copy.addEventListener('mousedown', (e) => e.preventDefault());
      copy.addEventListener('click', () => {
        const text = node.textContent;
        const done = () => {
          copy.textContent = 'Copied';
          setTimeout(() => {
            copy.textContent = 'Copy';
          }, 1200);
        };
        if (typeof navigator !== 'undefined' && navigator.clipboard) {
          navigator.clipboard.writeText(text).then(done).catch(() => {});
        }
      });

      chrome.appendChild(select);
      chrome.appendChild(copy);

      const pre = document.createElement('pre');
      pre.className = 'ae-code-block';
      const code = document.createElement('code');
      const lang0 = normalizeLanguage(node.attrs.language as string | null);
      code.className = `language-${lang0}`;
      pre.appendChild(code);

      dom.appendChild(chrome);
      dom.appendChild(pre);

      return {
        dom,
        contentDOM: code,
        update: (updated) => {
          if (updated.type.name !== this.name) return false;
          const lang = normalizeLanguage(updated.attrs.language as string | null);
          if (select.value !== lang) select.value = lang;
          code.className = `language-${lang}`;
          return true;
        },
      };
    };
  },
});

export { normalizeLanguage, languageLabel, CODE_LANGUAGES, DEFAULT_CODE_LANGUAGE };
