import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    breadcrumb: {
      /** Insert a breadcrumb block (renders the page ancestor trail). */
      setBreadcrumb: () => ReturnType;
    };
  }
}

/** One node in the breadcrumb trail. */
export interface BreadcrumbItem {
  id: string;
  title: string;
}

export interface BreadcrumbOptions {
  /** Ancestor trail (root → parent), supplied by the host from the page tree. */
  items: BreadcrumbItem[];
  /**
   * Live getter for the ancestor trail. Preferred over `items`: read at NodeView
   * render time so the host can update the trail (e.g. ancestors load async)
   * without re-configuring the extension / rebuilding the editor. Falls back to
   * `items` when omitted.
   */
  getItems?: () => BreadcrumbItem[];
  /** Navigate to a page id when a crumb is clicked. */
  onOpenPage?: (pageId: string) => void;
}

/** Display label for a crumb (title or "Untitled"). Pure → unit-tested. */
export function breadcrumbLabel(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t || 'Untitled';
}

/**
 * Breadcrumb — an atom block that renders the page's ancestor trail
 * ("A / B / C") as clickable links. The trail comes from the extension options
 * (`items`, set by the host from the page tree) rather than the doc, so it's an
 * atom with no stored content (no recursion). Clicking a crumb routes through
 * the `onOpenPage` hook. Serialises to `<div data-type="breadcrumb">`.
 */
export const Breadcrumb = Node.create<BreadcrumbOptions>({
  name: 'breadcrumb',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { items: [], getItems: undefined, onOpenPage: undefined };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="breadcrumb"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'breadcrumb',
        'data-testid': 'breadcrumb',
        class: 'ae-breadcrumb',
      }),
    ];
  },

  // A DOM NodeView so crumbs route clicks through the host's onOpenPage hook
  // (client/full nav) and reflect the live ancestor list from options.
  addNodeView() {
    return () => {
      const { onOpenPage } = this.options;
      const items = this.options.getItems ? this.options.getItems() : this.options.items;
      const dom = document.createElement('div');
      dom.setAttribute('data-type', 'breadcrumb');
      dom.setAttribute('data-testid', 'breadcrumb');
      dom.setAttribute('class', 'ae-breadcrumb');
      dom.setAttribute('contenteditable', 'false');

      if (!items || items.length === 0) {
        const empty = document.createElement('span');
        empty.setAttribute('class', 'ae-breadcrumb-empty');
        empty.textContent = 'Top level';
        dom.appendChild(empty);
        return { dom };
      }

      items.forEach((item, i) => {
        const link = document.createElement('a');
        link.setAttribute('class', 'ae-breadcrumb-crumb');
        link.setAttribute('href', `/p/${item.id}`);
        link.textContent = breadcrumbLabel(item.title);
        link.addEventListener('click', (event) => {
          if (onOpenPage && item.id) {
            event.preventDefault();
            onOpenPage(item.id);
          }
        });
        dom.appendChild(link);
        if (i < items.length - 1) {
          const sep = document.createElement('span');
          sep.setAttribute('class', 'ae-breadcrumb-sep');
          sep.textContent = '/';
          dom.appendChild(sep);
        }
      });

      return { dom };
    };
  },

  addCommands() {
    return {
      setBreadcrumb:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});
