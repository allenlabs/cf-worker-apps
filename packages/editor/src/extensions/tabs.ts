import { Node, mergeAttributes } from '@tiptap/core';
import { clampActiveTab, activeAfterRemove, defaultTabTitle } from '../lib/tabs';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    tabs: {
      /** Insert a 2-tab container, caret in the first tab's body. */
      setTabs: () => ReturnType;
    };
  }
}

/**
 * Tab — a single pane inside a {@link Tabs} container. Carries its `title`
 * (shown in the tab strip) as an attribute and holds block content. Serialises
 * to `<div data-type="tab" data-title="…">` so the title + body round-trip
 * through the HTML snapshot.
 */
export const Tab = Node.create({
  name: 'tab',
  content: 'block+',
  isolating: true,
  defining: true,

  addAttributes() {
    return {
      title: {
        default: 'Tab',
        parseHTML: (el) => el.getAttribute('data-title') ?? 'Tab',
        renderHTML: (attrs) => ({ 'data-title': attrs.title as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="tab"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, { 'data-type': 'tab', class: 'ae-tab' }),
      0,
    ];
  },
});

/**
 * Tabs — a container holding {@link Tab} children. A NodeView draws a clickable
 * tab strip (one button per child, plus an "+" to add and "×" to remove when
 * editable) and shows only the active tab's content. The active index lives in
 * the `active` attr so it syncs via Yjs in collab mode.
 *
 * Round-trips as `<div data-type="tabs" data-active="N">` so the HTML snapshot
 * keeps the selected tab. Read-only viewers can still switch tabs (the strip
 * stays clickable) but get no add/remove/rename affordances.
 */
export const Tabs = Node.create({
  name: 'tabs',
  group: 'block',
  content: 'tab+',
  defining: true,

  addAttributes() {
    return {
      active: {
        default: 0,
        parseHTML: (el) => Number(el.getAttribute('data-active') ?? '0') || 0,
        renderHTML: (attrs) => ({ 'data-active': String(attrs.active ?? 0) }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="tabs"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'tabs',
        'data-testid': 'tabs',
        class: 'ae-tabs',
      }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const editable = editor.isEditable;
      const dom = document.createElement('div');
      dom.className = 'ae-tabs';
      dom.setAttribute('data-type', 'tabs');
      dom.setAttribute('data-testid', 'tabs');

      // The tab strip (header buttons) — rebuilt on each update so titles +
      // counts stay current. Marked non-editable so ProseMirror leaves it alone.
      const strip = document.createElement('div');
      strip.className = 'ae-tabs-strip';
      strip.contentEditable = 'false';

      // The panes container is the contentDOM (holds the Tab children). CSS
      // hides every pane except the active one (via data-active on the wrapper).
      const panes = document.createElement('div');
      panes.className = 'ae-tabs-panes';

      function tabCount(): number {
        return node.childCount;
      }

      function setActive(next: number): void {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (pos == null) return;
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeAttribute(pos, 'active', clampActiveTab(next, tabCount()));
            return true;
          })
          .run();
      }

      function renameTab(index: number, title: string): void {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (pos == null) return;
        // The nth tab starts one position into the container.
        let childPos = pos + 1;
        for (let i = 0; i < index; i++) childPos += node.child(i).nodeSize;
        editor
          .chain()
          .command(({ tr }) => {
            tr.setNodeAttribute(childPos, 'title', title);
            return true;
          })
          .run();
      }

      function addTab(): void {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (pos == null) return;
        const endInside = pos + node.nodeSize - 1; // before the container's close
        const count = tabCount();
        editor
          .chain()
          .command(({ tr }) => {
            const type = editor.schema.nodes.tab;
            const para = editor.schema.nodes.paragraph;
            if (!type || !para) return false;
            const tab = type.create({ title: defaultTabTitle(count) }, para.create());
            tr.insert(endInside, tab);
            tr.setNodeAttribute(pos, 'active', count);
            return true;
          })
          .run();
      }

      function removeTab(index: number): void {
        if (typeof getPos !== 'function') return;
        const count = tabCount();
        if (count <= 1) return; // keep at least one tab
        const pos = getPos();
        if (pos == null) return;
        let childPos = pos + 1;
        for (let i = 0; i < index; i++) childPos += node.child(i).nodeSize;
        const size = node.child(index).nodeSize;
        const nextActive = activeAfterRemove(node.attrs.active as number, index, count);
        editor
          .chain()
          .command(({ tr }) => {
            tr.delete(childPos, childPos + size);
            tr.setNodeAttribute(pos, 'active', nextActive);
            return true;
          })
          .run();
      }

      function renderStrip(n = node): void {
        strip.replaceChildren();
        const active = clampActiveTab(n.attrs.active as number, n.childCount);
        for (let i = 0; i < n.childCount; i++) {
          const child = n.child(i);
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'ae-tab-btn';
          btn.dataset.active = String(i === active);
          btn.textContent = (child.attrs.title as string) || defaultTabTitle(i);
          const idx = i;
          btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            setActive(idx);
          });
          if (editable) {
            // Double-click a tab to rename it via a prompt (keeps the NodeView
            // light; the title attr syncs via Yjs).
            btn.addEventListener('dblclick', (e) => {
              e.preventDefault();
              const current = (child.attrs.title as string) || defaultTabTitle(idx);
              const next = typeof window !== 'undefined' ? window.prompt('Tab title', current) : null;
              if (next != null) renameTab(idx, next.trim() || current);
            });
            if (n.childCount > 1) {
              const close = document.createElement('span');
              close.className = 'ae-tab-remove';
              close.textContent = '×';
              close.setAttribute('role', 'button');
              close.setAttribute('aria-label', 'Remove tab');
              close.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                removeTab(idx);
              });
              btn.appendChild(close);
            }
          }
          strip.appendChild(btn);
        }
        if (editable) {
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'ae-tab-add';
          add.textContent = '+';
          add.setAttribute('aria-label', 'Add tab');
          add.addEventListener('mousedown', (e) => {
            e.preventDefault();
            addTab();
          });
          strip.appendChild(add);
        }
      }

      renderStrip();
      dom.dataset.active = String(clampActiveTab(node.attrs.active as number, node.childCount));
      dom.appendChild(strip);
      dom.appendChild(panes);

      return {
        dom,
        contentDOM: panes,
        update: (updated) => {
          if (updated.type.name !== 'tabs') return false;
          node = updated;
          dom.dataset.active = String(clampActiveTab(updated.attrs.active as number, updated.childCount));
          renderStrip(updated);
          return true;
        },
      };
    };
  },

  addCommands() {
    return {
      setTabs:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { active: 0 },
            content: [
              { type: 'tab', attrs: { title: defaultTabTitle(0) }, content: [{ type: 'paragraph' }] },
              { type: 'tab', attrs: { title: defaultTabTitle(1) }, content: [{ type: 'paragraph' }] },
            ],
          }),
    };
  },
});
