import type { SlashItem } from './types';

/**
 * Default block menu — the common Notion-ish set, all from TipTap StarterKit
 * nodes (no proprietary blocks). Consumers can replace or extend this list.
 */
export const DEFAULT_SLASH_ITEMS: SlashItem[] = [
  {
    title: 'Text',
    hint: 'Plain paragraph',
    keywords: ['paragraph', 'p', 'body'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    hint: 'Big section heading',
    keywords: ['h1', 'title', 'big'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    hint: 'Medium section heading',
    keywords: ['h2', 'subtitle'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    hint: 'Small section heading',
    keywords: ['h3'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    title: 'Bulleted list',
    hint: 'Simple bullet list',
    keywords: ['ul', 'unordered', 'bullet'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Numbered list',
    hint: 'Ordered list',
    keywords: ['ol', 'ordered', 'number'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'To-do list',
    hint: 'Checkbox task list',
    keywords: ['todo', 'task', 'checkbox', 'check'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: 'Quote',
    hint: 'Block quote',
    keywords: ['blockquote', 'cite'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Code block',
    hint: 'Monospace code',
    keywords: ['code', 'pre', 'snippet'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Divider',
    hint: 'Horizontal rule',
    keywords: ['hr', 'rule', 'separator', 'line'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
  {
    title: 'Callout',
    hint: 'Highlighted note block',
    keywords: ['note', 'info', 'tip', 'aside', 'box'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setCallout().run(),
  },
  {
    title: 'Toggle',
    hint: 'Collapsible section',
    keywords: ['collapse', 'details', 'expand', 'accordion'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setToggle().run(),
  },
  {
    title: 'Image',
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
    hint: '2-column layout',
    keywords: ['column', 'layout', 'split', 'side'],
    command: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setColumns().run(),
  },
  {
    title: 'Bookmark',
    hint: 'Link card from a URL',
    keywords: ['link', 'url', 'card', 'embed'],
    command: ({ editor, range }) => {
      const url = typeof window !== 'undefined' ? window.prompt('Bookmark URL') : null;
      editor.chain().focus().deleteRange(range).run();
      if (url) editor.chain().focus().setBookmark({ url }).run();
    },
  },
];

/** Case-insensitive filter over title + keywords. Pure, so it's unit-tested. */
export function filterSlashItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    if (it.title.toLowerCase().includes(q)) return true;
    return (it.keywords ?? []).some((k) => k.toLowerCase().includes(q));
  });
}
