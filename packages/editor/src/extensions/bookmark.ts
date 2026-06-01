import { Node, mergeAttributes } from '@tiptap/core';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    bookmark: {
      /** Insert a bookmark card for a URL. */
      setBookmark: (attrs: { url: string }) => ReturnType;
    };
  }
}

/** Best-effort hostname for the card label; falls back to the raw url. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Bookmark — an atom block storing a `url`, rendered as a simple link card
 * (favicon via Google's s2 service + hostname). Inserted from a URL prompt.
 */
export const Bookmark = Node.create({
  name: 'bookmark',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addAttributes() {
    return {
      url: {
        default: '',
        parseHTML: (el) => el.getAttribute('href') ?? el.getAttribute('data-url') ?? '',
        renderHTML: (attrs) => ({ 'data-url': attrs.url as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-type="bookmark"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const url = (HTMLAttributes['data-url'] as string) || '';
    const host = hostOf(url);
    return [
      'a',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'bookmark',
        'data-testid': 'bookmark',
        class: 'ae-bookmark',
        href: url,
        target: '_blank',
        rel: 'noopener noreferrer',
      }),
      [
        'img',
        {
          class: 'ae-bookmark-favicon',
          src: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=32`,
          alt: '',
          contenteditable: 'false',
        },
      ],
      ['span', { class: 'ae-bookmark-host' }, host],
    ];
  },

  addCommands() {
    return {
      setBookmark:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({ type: this.name, attrs }),
    };
  },
});
