import type { SlashItem } from './types';

/**
 * Default block menu — the common Notion-ish set, all from TipTap StarterKit
 * nodes (no proprietary blocks). Consumers can replace or extend this list.
 */
export const DEFAULT_SLASH_ITEMS: SlashItem[] = [
  {
    title: 'Text',
    icon: '¶',
    hint: 'Plain paragraph',
    keywords: ['paragraph', 'p', 'body'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    icon: 'H1',
    hint: 'Big section heading',
    keywords: ['h1', 'title', 'big'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    icon: 'H2',
    hint: 'Medium section heading',
    keywords: ['h2', 'subtitle'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    icon: 'H3',
    hint: 'Small section heading',
    keywords: ['h3'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    title: 'Bulleted list',
    icon: '•',
    hint: 'Simple bullet list',
    keywords: ['ul', 'unordered', 'bullet'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Numbered list',
    icon: '1.',
    hint: 'Ordered list',
    keywords: ['ol', 'ordered', 'number'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'To-do list',
    icon: '☑',
    hint: 'Checkbox task list',
    keywords: ['todo', 'task', 'checkbox', 'check'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: 'Quote',
    icon: '❝',
    hint: 'Block quote',
    keywords: ['blockquote', 'cite'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Code block',
    icon: '</>',
    hint: 'Monospace code',
    keywords: ['code', 'pre', 'snippet'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Divider',
    icon: '―',
    hint: 'Horizontal rule',
    keywords: ['hr', 'rule', 'separator', 'line'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: 'Callout',
    icon: '💡',
    hint: 'Highlighted note block',
    keywords: ['note', 'info', 'tip', 'aside', 'box'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setCallout().run(),
  },
  {
    title: 'Toggle',
    icon: '▸',
    hint: 'Collapsible section',
    keywords: ['collapse', 'details', 'expand', 'accordion'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setToggle().run(),
  },
  {
    title: 'Image',
    icon: '🖼',
    hint: 'Upload or embed by URL',
    keywords: ['img', 'picture', 'photo', 'embed'],
    // Default behaviour prompts for a URL. CollaborativeEditor overrides this
    // with an upload flow when an `uploadImage` handler is provided.
    command: ({ editor, range }) => {
      const url = typeof window !== 'undefined' ? window.prompt('Image URL') : null;
      editor.chain().focus().deleteRange(range).run();
      if (url) editor.chain().focus().setImage({ src: url }).run();
    },
  },
  {
    title: 'Table',
    icon: '▦',
    hint: '3×3 grid with header row',
    keywords: ['grid', 'spreadsheet', 'cells', 'rows', 'columns'],
    command: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertTable({ rows: 3, cols: 3, withHeaderRow: true })
        .run(),
  },
  {
    title: 'Columns',
    icon: '⫴',
    hint: '2-column layout',
    keywords: ['column', 'layout', 'split', 'side'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setColumns().run(),
  },
  {
    title: 'Tabs',
    icon: '🗂️',
    hint: 'Tabbed sections',
    keywords: ['tab', 'tabbed', 'panel', 'sections', 'switch'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setTabs().run(),
  },
  {
    title: 'Bookmark',
    icon: '🔖',
    hint: 'Link card from a URL',
    keywords: ['link', 'url', 'card', 'embed'],
    command: ({ editor, range }) => {
      const url = typeof window !== 'undefined' ? window.prompt('Bookmark URL') : null;
      editor.chain().focus().deleteRange(range).run();
      if (url) editor.chain().focus().setBookmark({ url }).run();
    },
  },
  {
    title: 'Equation',
    icon: '∑',
    hint: 'Display math (KaTeX)',
    keywords: ['math', 'latex', 'katex', 'formula', 'tex'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setMathBlock().run(),
  },
  {
    title: 'Embed',
    icon: '🔗',
    hint: 'YouTube, Vimeo, Figma, Maps…',
    keywords: ['iframe', 'youtube', 'vimeo', 'figma', 'map', 'video', 'embed'],
    command: ({ editor, range }) => {
      const url = typeof window !== 'undefined' ? window.prompt('Embed URL') : null;
      editor.chain().focus().deleteRange(range).run();
      if (url) editor.chain().focus().setEmbed({ url }).run();
    },
  },
  {
    title: 'Video',
    icon: '🎬',
    hint: 'Upload or embed by URL',
    keywords: ['movie', 'mp4', 'media', 'clip'],
    // Default behaviour prompts for a URL; CollaborativeEditor overrides this
    // with an upload flow when an `uploadFile` handler is provided.
    command: ({ editor, range }) => {
      const url = typeof window !== 'undefined' ? window.prompt('Video URL') : null;
      editor.chain().focus().deleteRange(range).run();
      if (url) editor.chain().focus().setVideo({ src: url }).run();
    },
  },
  {
    title: 'Audio',
    icon: '🎵',
    hint: 'Upload or embed by URL',
    keywords: ['sound', 'mp3', 'media', 'music', 'voice'],
    command: ({ editor, range }) => {
      const url = typeof window !== 'undefined' ? window.prompt('Audio URL') : null;
      editor.chain().focus().deleteRange(range).run();
      if (url) editor.chain().focus().setAudio({ src: url }).run();
    },
  },
  {
    title: 'File',
    icon: '📎',
    hint: 'Upload or link a file',
    keywords: ['attachment', 'download', 'document', 'pdf'],
    command: ({ editor, range }) => {
      const url = typeof window !== 'undefined' ? window.prompt('File URL') : null;
      editor.chain().focus().deleteRange(range).run();
      if (url) editor.chain().focus().setFile({ src: url }).run();
    },
  },
  {
    title: 'Table of contents',
    icon: '🗂',
    hint: 'Live outline of headings',
    keywords: ['toc', 'outline', 'contents', 'index', 'headings'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setTableOfContents().run(),
  },
  {
    title: 'Breadcrumb',
    icon: '⤳',
    hint: 'Page ancestor trail',
    keywords: ['path', 'trail', 'ancestors', 'navigation', 'parent'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setBreadcrumb().run(),
  },
];

/**
 * Build the "Page" slash item that creates a sub-page and inserts a childPage
 * block. Kept pure (factory taking the create hook) so it's unit-testable: the
 * command deletes the slash range, derives a seed title from the current line,
 * awaits `onCreate`, then inserts the returned child-page node.
 */
export function makeChildPageSlashItem(
  onCreate: (title: string) => Promise<{ id: string; title: string; icon?: string }>,
): SlashItem {
  return {
    title: 'Page',
    icon: '📄',
    hint: 'Embed a new sub-page',
    keywords: ['sub-page', 'subpage', 'child', 'page', 'nested'],
    command: ({ editor, range }) => {
      // Use the text already typed on the line (after "/") as the seed title.
      const seed = editor.state.doc.textBetween(range.from, range.to).replace(/^\//, '').trim();
      const title = seed || 'Untitled';
      editor.chain().focus().deleteRange(range).run();
      void onCreate(title).then((created) => {
        editor
          .chain()
          .focus()
          .setChildPage({ pageId: created.id, title: created.title, icon: created.icon })
          .run();
      });
    },
  };
}

/**
 * Build the "Synced block" slash item. Inserts a `syncedBlock` node with a
 * fresh `crypto.randomUUID()` syncId (the node binds room `sync-<syncId>`).
 * Kept pure so it's unit-testable: the command deletes the slash range, then
 * inserts the node (the node's `setSyncedBlock` command supplies the id when
 * none is given). `title`/`hint` are optional (host-translated) labels.
 */
export function makeSyncedBlockSlashItem(opts?: { title?: string; hint?: string }): SlashItem {
  return {
    title: opts?.title ?? 'Synced block',
    icon: '🔁',
    hint: opts?.hint ?? 'Content mirrored across pages',
    keywords: ['sync', 'synced', 'mirror', 'shared', 'linked'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setSyncedBlock().run();
    },
  };
}

/**
 * Build the "Linked database view" slash item. Calls the host `onPick` to choose
 * a source database; on resolution inserts a `linkedDatabase` node referencing
 * it (no DB is moved). Kept pure (factory taking the pick hook) so it's
 * unit-testable. A null/undefined resolution (user cancelled) inserts nothing.
 * `title`/`hint` are optional host-translated labels.
 */
export function makeLinkedDatabaseSlashItem(
  onPick: () => Promise<{ databaseId: string; title?: string; viewId?: string | null } | null>,
  opts?: { title?: string; hint?: string },
): SlashItem {
  return {
    title: opts?.title ?? 'Linked database view',
    icon: '🔗',
    hint: opts?.hint ?? 'Embed an existing database',
    keywords: ['linked', 'database', 'db', 'view', 'embed', 'reference'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      void onPick().then((picked) => {
        if (!picked || !picked.databaseId) return;
        editor
          .chain()
          .focus()
          .setLinkedDatabase({
            databaseId: picked.databaseId,
            title: picked.title,
            viewId: picked.viewId ?? null,
          })
          .run();
      });
    },
  };
}

/**
 * Build the "Button" slash item. Inserts a `button` atom node with an empty
 * action list (configured afterwards via the ⚙ affordance in the NodeView).
 * Kept pure so it's unit-testable. `title`/`hint` are optional host-translated
 * labels.
 */
export function makeButtonSlashItem(opts?: { title?: string; hint?: string }): SlashItem {
  return {
    title: opts?.title ?? 'Button',
    icon: '🔘',
    hint: opts?.hint ?? 'A clickable button that runs actions',
    keywords: ['button', 'action', 'cta', 'click', 'trigger'],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).setButton().run();
    },
  };
}

/** Case-insensitive filter over title + keywords. Pure, so it's unit-tested. */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    if (it.title.toLowerCase().includes(q)) return true;
    return (it.keywords ?? []).some((k) => k.toLowerCase().includes(q));
  });
}
