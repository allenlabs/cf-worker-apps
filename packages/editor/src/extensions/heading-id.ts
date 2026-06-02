import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { ensureHeadingId, type TocEntry } from '../lib/headings';

/**
 * Walk the doc and return every heading (level 1–3) as a TOC entry, using each
 * heading node's `id` attr as the scroll anchor. Headings without an id are
 * skipped (the HeadingId plugin assigns ids, so post-init this is rare). Pure
 * over a ProseMirror doc → callers (the TOC NodeView) re-run it on every update.
 */
export function collectHeadings(doc: PMNode): TocEntry[] {
  const out: TocEntry[] = [];
  doc.descendants((node) => {
    if (node.type.name === 'heading') {
      const level = (node.attrs.level as number) ?? 1;
      if (level >= 1 && level <= 3) {
        out.push({ level, text: node.textContent, id: (node.attrs.id as string) || '' });
      }
      return false; // headings have no block children we care about
    }
    return true;
  });
  return out;
}

const headingIdKey = new PluginKey('aeHeadingId');

/**
 * HeadingId — extends the (StarterKit) Heading node with a stable `id` attribute
 * and a plugin that assigns missing/duplicate ids as the doc changes, so the
 * table-of-contents can scroll to each heading. The id is a slug of the heading
 * text (deduped); it serialises to the heading's `id` HTML attribute so it
 * round-trips and works as a `#anchor`.
 *
 * Implemented as `Heading.extend`-style attribute injection via
 * `extendNodeSchema`-free approach: we use `addGlobalAttributes` to attach `id`
 * to the existing `heading` node (so we don't have to re-declare Heading), plus
 * an appendTransaction plugin to fill in ids.
 */
export const HeadingId = Extension.create({
  name: 'aeHeadingId',

  addGlobalAttributes() {
    return [
      {
        types: ['heading'],
        attributes: {
          id: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute('id'),
            renderHTML: (attrs: Record<string, unknown>) =>
              attrs.id ? { id: attrs.id as string } : {},
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: headingIdKey,
        // After any doc change, ensure every heading has a unique id. Returns a
        // transaction setting missing/duplicate ids, or null when nothing
        // changed (so we never loop).
        appendTransaction: (_transactions, _oldState, newState) => {
          const used = new Set<string>();
          const updates: { pos: number; id: string }[] = [];
          newState.doc.descendants((node, pos) => {
            if (node.type.name !== 'heading') return true;
            const current = (node.attrs.id as string | null) ?? null;
            const id = ensureHeadingId(current, node.textContent, used);
            if (id !== current) updates.push({ pos, id });
            return false;
          });
          if (updates.length === 0) return null;
          const tr = newState.tr;
          for (const u of updates) {
            const node = newState.doc.nodeAt(u.pos);
            if (node) tr.setNodeMarkup(u.pos, undefined, { ...node.attrs, id: u.id });
          }
          tr.setMeta('addToHistory', false);
          return tr;
        },
      }),
    ];
  },
});
