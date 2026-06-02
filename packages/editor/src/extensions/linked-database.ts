import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    linkedDatabase: {
      /**
       * Insert a linked-database block referencing an existing database. The
       * optional `viewId` pins a saved view; otherwise the host picks a default.
       */
      setLinkedDatabase: (attrs: {
        databaseId: string;
        title?: string;
        viewId?: string | null;
      }) => ReturnType;
    };
  }
}

export const LINKED_DATABASE_ICON = '🔗';

/** Display label for a linked-database card; "Untitled database" when blank. */
export function linkedDatabaseLabel(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t || 'Untitled database';
}

export interface LinkedDatabaseOptions {
  /**
   * Host navigation hook. Called with the source database id when the linked-DB
   * card is clicked, so the host routes via its own router / full-page nav.
   */
  onOpenDatabase?: (databaseId: string) => void;
}

/**
 * linkedDatabase — an atom block node that embeds a reference to an existing
 * database WITHOUT moving it (Notion "Linked database view"). Stores
 * `{ databaseId, title, viewId }` and serialises to a
 * `<a data-type="linked-database" data-database-id="…" data-view-id="…">` so it
 * round-trips through the HTML snapshot. A NodeView renders a clickable card and
 * routes clicks through the `onOpenDatabase` host hook. The host renders the
 * actual rows (a compact DatabaseView bound to the source database id + a linked
 * view's filters/sorts) outside the editor; this node is the durable anchor.
 */
export const LinkedDatabase = Node.create<LinkedDatabaseOptions>({
  name: 'linkedDatabase',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { onOpenDatabase: undefined };
  },

  addAttributes() {
    return {
      databaseId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-database-id') ?? '',
        renderHTML: (attrs) => ({ 'data-database-id': attrs.databaseId as string }),
      },
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-title') ?? el.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-title': attrs.title as string }),
      },
      viewId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-view-id') ?? '',
        renderHTML: (attrs) => (attrs.viewId ? { 'data-view-id': attrs.viewId as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-type="linked-database"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const databaseId = (HTMLAttributes['data-database-id'] as string) || '';
    const title = linkedDatabaseLabel(HTMLAttributes['data-title'] as string);
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'linked-database',
        'data-testid': 'linked-database',
        class: 'ae-linked-database',
        href: `/p/${databaseId}`,
      }),
      ['span', { class: 'ae-linked-database-icon', contenteditable: 'false' }, LINKED_DATABASE_ICON],
      ['span', { class: 'ae-linked-database-title' }, title],
    ];
  },

  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const onOpen = this.options.onOpenDatabase;
      const databaseId = (node.attrs.databaseId as string) || '';
      const title = linkedDatabaseLabel(node.attrs.title as string);

      const dom = document.createElement('a');
      Object.assign(dom, HTMLAttributes);
      dom.setAttribute('data-type', 'linked-database');
      dom.setAttribute('data-testid', 'linked-database');
      dom.setAttribute('data-database-id', databaseId);
      dom.setAttribute('class', 'ae-linked-database');
      dom.setAttribute('href', `/p/${databaseId}`);

      const iconEl = document.createElement('span');
      iconEl.setAttribute('class', 'ae-linked-database-icon');
      iconEl.setAttribute('contenteditable', 'false');
      iconEl.textContent = LINKED_DATABASE_ICON;

      const titleEl = document.createElement('span');
      titleEl.setAttribute('class', 'ae-linked-database-title');
      titleEl.textContent = title;

      dom.appendChild(iconEl);
      dom.appendChild(titleEl);

      dom.addEventListener('click', (event) => {
        if (onOpen && databaseId) {
          event.preventDefault();
          onOpen(databaseId);
        }
      });

      return { dom };
    };
  },

  addCommands() {
    return {
      setLinkedDatabase:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: {
              databaseId: attrs.databaseId,
              title: attrs.title ?? '',
              viewId: attrs.viewId ?? '',
            },
          }),
    };
  },
});
