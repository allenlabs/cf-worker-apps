import type { Editor } from '@tiptap/core';

/**
 * Block-menu "Turn into" targets. Each maps a label to the editor command that
 * converts the block at `pos` into that type. Kept as a pure data table (no DOM,
 * no React) so the action wiring is unit-testable and the menu component just
 * renders it.
 */
export type TurnIntoId =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulletList'
  | 'orderedList'
  | 'taskList'
  | 'blockquote'
  | 'callout'
  | 'codeBlock'
  | 'toggle';

export interface TurnIntoTarget {
  id: TurnIntoId;
  /** Short emoji/glyph affordance shown left of the label. */
  icon: string;
  /** i18n key the host can translate; falls back to {@link defaultLabel}. */
  labelKey: string;
}

/** The ordered "Turn into" list — mirrors Notion's common block set. */
export const TURN_INTO_TARGETS: TurnIntoTarget[] = [
  { id: 'paragraph', icon: '¶', labelKey: 'block.text' },
  { id: 'h1', icon: 'H1', labelKey: 'block.h1' },
  { id: 'h2', icon: 'H2', labelKey: 'block.h2' },
  { id: 'h3', icon: 'H3', labelKey: 'block.h3' },
  { id: 'bulletList', icon: '•', labelKey: 'block.bulletList' },
  { id: 'orderedList', icon: '1.', labelKey: 'block.orderedList' },
  { id: 'taskList', icon: '☑', labelKey: 'block.taskList' },
  { id: 'blockquote', icon: '❝', labelKey: 'block.quote' },
  { id: 'callout', icon: '💡', labelKey: 'block.callout' },
  { id: 'codeBlock', icon: '</>', labelKey: 'block.code' },
  { id: 'toggle', icon: '▸', labelKey: 'block.toggle' },
];

/** English fallback labels (used when the host passes no translator). */
export const DEFAULT_BLOCK_LABELS: Record<string, string> = {
  'block.text': 'Text',
  'block.h1': 'Heading 1',
  'block.h2': 'Heading 2',
  'block.h3': 'Heading 3',
  'block.bulletList': 'Bulleted list',
  'block.orderedList': 'Numbered list',
  'block.taskList': 'To-do list',
  'block.quote': 'Quote',
  'block.callout': 'Callout',
  'block.code': 'Code',
  'block.toggle': 'Toggle',
  'block.turnInto': 'Turn into',
  'block.duplicate': 'Duplicate',
  'block.delete': 'Delete',
  'block.color': 'Color',
  'block.colorDefault': 'Default',
};

/** A text/background color choice in the Color submenu. */
export interface ColorChoice {
  id: string;
  labelKey: string;
  /** A CSS color for text (or null = clear). */
  textColor?: string | null;
  /** A CSS color for a callout/background tint (or null = clear). */
  bgColor?: string | null;
}

/** A small, tasteful palette of text colors + background tints (Notion-ish). */
export const TEXT_COLORS: ColorChoice[] = [
  { id: 'default', labelKey: 'block.colorDefault', textColor: null },
  { id: 'gray', labelKey: 'color.gray', textColor: '#6b7280' },
  { id: 'red', labelKey: 'color.red', textColor: '#dc2626' },
  { id: 'orange', labelKey: 'color.orange', textColor: '#ea580c' },
  { id: 'green', labelKey: 'color.green', textColor: '#16a34a' },
  { id: 'blue', labelKey: 'color.blue', textColor: '#2563eb' },
  { id: 'purple', labelKey: 'color.purple', textColor: '#9333ea' },
];

export const BG_COLORS: ColorChoice[] = [
  { id: 'bg-gray', labelKey: 'color.bgGray', bgColor: '#f3f4f6' },
  { id: 'bg-yellow', labelKey: 'color.bgYellow', bgColor: '#fef9c3' },
  { id: 'bg-green', labelKey: 'color.bgGreen', bgColor: '#dcfce7' },
  { id: 'bg-blue', labelKey: 'color.bgBlue', bgColor: '#dbeafe' },
  { id: 'bg-pink', labelKey: 'color.bgPink', bgColor: '#fce7f3' },
];

/** Resolve a 0-based document position to the top-level block it sits in. */
export function topLevelBlockAt(
  editor: Editor,
  pos: number,
): { from: number; to: number; pos: number } | null {
  const { doc } = editor.state;
  const safePos = Math.max(0, Math.min(pos, doc.content.size));
  const $pos = doc.resolve(safePos);
  // depth 1 == a direct child of the document (the top-level block).
  const depth = $pos.depth >= 1 ? 1 : $pos.depth;
  const node = $pos.node(depth);
  if (!node) return null;
  const from = depth === 0 ? 0 : $pos.before(depth);
  const to = from + node.nodeSize;
  return { from, to, pos: from };
}

/** Place the selection inside the block that starts at `from`, then focus. */
function selectInsideBlock(editor: Editor, from: number): void {
  // +1 steps past the block's opening token into its content.
  const inside = Math.min(from + 1, editor.state.doc.content.size);
  editor.chain().focus().setTextSelection(inside).run();
}

/**
 * Convert the block at `pos` into `target`. Returns true when a command ran.
 * Pure aside from the editor mutation, so it's exercised by the menu tests via
 * a mock editor.
 */
export function turnBlockInto(editor: Editor, pos: number, target: TurnIntoId): boolean {
  const block = topLevelBlockAt(editor, pos);
  if (!block) return false;
  selectInsideBlock(editor, block.from);
  const c = editor.chain().focus();
  switch (target) {
    case 'paragraph':
      return c.clearNodes().setParagraph().run();
    case 'h1':
      return c.clearNodes().setNode('heading', { level: 1 }).run();
    case 'h2':
      return c.clearNodes().setNode('heading', { level: 2 }).run();
    case 'h3':
      return c.clearNodes().setNode('heading', { level: 3 }).run();
    case 'bulletList':
      return c.toggleBulletList().run();
    case 'orderedList':
      return c.toggleOrderedList().run();
    case 'taskList':
      return c.toggleTaskList().run();
    case 'blockquote':
      return c.toggleBlockquote().run();
    case 'callout':
      return c.clearNodes().setCallout().run();
    case 'codeBlock':
      return c.clearNodes().toggleCodeBlock().run();
    case 'toggle':
      return c.clearNodes().setToggle().run();
    default:
      return false;
  }
}

/** Duplicate the block at `pos`, inserting the clone immediately below it. */
export function duplicateBlock(editor: Editor, pos: number): boolean {
  const block = topLevelBlockAt(editor, pos);
  if (!block) return false;
  const node = editor.state.doc.resolve(block.from).nodeAfter;
  if (!node) return false;
  return editor.chain().focus().insertContentAt(block.to, node.toJSON()).run();
}

/** Delete the block at `pos` entirely. */
export function deleteBlock(editor: Editor, pos: number): boolean {
  const block = topLevelBlockAt(editor, pos);
  if (!block) return false;
  return editor.chain().focus().deleteRange({ from: block.from, to: block.to }).run();
}

/**
 * Apply a color choice to the block at `pos`. A text color sets the TextStyle
 * color mark across the block's range; a background tint converts the block to
 * a callout with that tint (Notion uses callout-like tinted blocks). Clearing
 * (null) unsets the text color.
 */
export function colorBlock(editor: Editor, pos: number, choice: ColorChoice): boolean {
  const block = topLevelBlockAt(editor, pos);
  if (!block) return false;
  if (choice.bgColor !== undefined && choice.bgColor !== null) {
    // Background tint → wrap in a callout carrying the tint.
    selectInsideBlock(editor, block.from);
    return editor.chain().focus().setCallout({ color: choice.bgColor }).run();
  }
  // Text color across the whole block's text range.
  const c = editor.chain().focus().setTextSelection({ from: block.from, to: block.to });
  if (choice.textColor === null || choice.textColor === undefined) {
    return c.unsetColor().run();
  }
  return c.setColor(choice.textColor).run();
}

/** Insert an empty paragraph below the block at `pos`; place caret inside it. */
export function insertParagraphBelow(editor: Editor, pos: number): number | null {
  const block = topLevelBlockAt(editor, pos);
  if (!block) return null;
  editor
    .chain()
    .focus()
    .insertContentAt(block.to, { type: 'paragraph' })
    .run();
  // Caret lands inside the new paragraph (just past the insertion point).
  const caret = Math.min(block.to + 1, editor.state.doc.content.size);
  editor.chain().focus().setTextSelection(caret).run();
  return caret;
}
