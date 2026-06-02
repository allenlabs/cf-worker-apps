import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    childPage: {
      /** Insert an inline child-page block linking to an existing page. */
      setChildPage: (attrs: { pageId: string; title?: string; icon?: string }) => ReturnType;
    };
  }
}

/** Default emoji shown when a child page has no icon. */
export const CHILD_PAGE_DEFAULT_ICON = '📄';

/**
 * Display text for a child-page row: the title, or "Untitled" when blank. Pure,
 * so it's unit-tested independent of the ProseMirror runtime.
 */
export function childPageLabel(title: string | null | undefined): string {
  const t = (title ?? '').trim();
  return t || 'Untitled';
}

export interface ChildPageOptions {
  /**
   * Host navigation hook. Called with the page id when a child-page row is
   * clicked, so the host can route via its own router / full-page nav instead
   * of a raw anchor href. Omit for a no-op (e.g. read-only previews).
   */
  onOpenPage?: (pageId: string) => void;
}

/**
 * childPage — an atom block node that embeds a link to a sub-page (Notion-style
 * inline child page). Stores `{ pageId, title, icon }` and serialises to an
 * `<a data-type="child-page" data-page-id="…">` so it round-trips through the
 * HTML snapshot. A NodeView renders the clickable row and routes clicks through
 * the `onOpenPage` host hook (rather than the bare href) so the host controls
 * navigation. The stored title is a snapshot label; the sidebar/breadcrumb show
 * the live title.
 */
export const ChildPage = Node.create<ChildPageOptions>({
  name: 'childPage',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { onOpenPage: undefined };
  },

  addAttributes() {
    return {
      pageId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-page-id') ?? '',
        renderHTML: (attrs) => ({ 'data-page-id': attrs.pageId as string }),
      },
      title: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-title') ?? el.textContent ?? '',
        renderHTML: (attrs) => ({ 'data-title': attrs.title as string }),
      },
      icon: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-icon') ?? '',
        renderHTML: (attrs) => (attrs.icon ? { 'data-icon': attrs.icon as string } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-type="child-page"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const pageId = (HTMLAttributes['data-page-id'] as string) || '';
    const title = childPageLabel(HTMLAttributes['data-title'] as string);
    const icon = (HTMLAttributes['data-icon'] as string) || CHILD_PAGE_DEFAULT_ICON;
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'child-page',
        'data-testid': 'child-page',
        class: 'ae-child-page',
        href: `/p/${pageId}`,
      }),
      ['span', { class: 'ae-child-page-icon', contenteditable: 'false' }, icon],
      ['span', { class: 'ae-child-page-title' }, title],
    ];
  },

  // A DOM NodeView so a click routes through the host hook (client nav / full
  // nav) instead of following the raw href. Keeps the node an atom (no inner
  // editing) while giving us a live, accessible row.
  addNodeView() {
    return ({ node, HTMLAttributes }) => {
      const onOpen = this.options.onOpenPage;
      const pageId = (node.attrs.pageId as string) || '';
      const title = childPageLabel(node.attrs.title as string);
      const icon = (node.attrs.icon as string) || CHILD_PAGE_DEFAULT_ICON;

      const dom = document.createElement('a');
      Object.assign(dom, HTMLAttributes);
      dom.setAttribute('data-type', 'child-page');
      dom.setAttribute('data-testid', 'child-page');
      dom.setAttribute('data-page-id', pageId);
      dom.setAttribute('class', 'ae-child-page');
      dom.setAttribute('href', `/p/${pageId}`);

      const iconEl = document.createElement('span');
      iconEl.setAttribute('class', 'ae-child-page-icon');
      iconEl.setAttribute('contenteditable', 'false');
      iconEl.textContent = icon;

      const titleEl = document.createElement('span');
      titleEl.setAttribute('class', 'ae-child-page-title');
      titleEl.textContent = title;

      dom.appendChild(iconEl);
      dom.appendChild(titleEl);

      dom.addEventListener('click', (event) => {
        // Route through the host so it can use client routing / full nav.
        if (onOpen && pageId) {
          event.preventDefault();
          onOpen(pageId);
        }
      });

      return { dom };
    };
  },

  addCommands() {
    return {
      setChildPage:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { pageId: attrs.pageId, title: attrs.title ?? '', icon: attrs.icon ?? '' },
          }),
    };
  },
});
