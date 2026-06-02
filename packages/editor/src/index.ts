export { CollaborativeEditor } from './CollaborativeEditor';
export { SlashCommand } from './extensions/slash';
export { makeMention } from './extensions/mention';
export { Callout } from './extensions/callout';
export { Toggle, ToggleSummary } from './extensions/toggle';
export { Bookmark } from './extensions/bookmark';
export { Columns, Column } from './extensions/columns';
export { Comment, commentThreadIdAt } from './extensions/comment';
export { ChildPage, childPageLabel, CHILD_PAGE_DEFAULT_ICON } from './extensions/child-page';
export { SyncedBlock, syncRoom } from './extensions/synced-block';
export type { SyncedBlockConfig, SyncedBlockOptions } from './extensions/synced-block';
export { BubbleToolbar } from './extensions/bubble-toolbar';
export { DragHandle } from './extensions/block-menu';
export { MarkdownRules, TODO_INPUT_REGEX } from './extensions/markdown-rules';
export {
  TURN_INTO_TARGETS,
  TEXT_COLORS,
  BG_COLORS,
  DEFAULT_BLOCK_LABELS,
  topLevelBlockAt,
  turnBlockInto,
  duplicateBlock,
  deleteBlock,
  colorBlock,
  insertParagraphBelow,
} from './lib/block-actions';
export type { TurnIntoId, TurnIntoTarget, ColorChoice } from './lib/block-actions';
export {
  DEFAULT_SLASH_ITEMS,
  filterSlashItems,
  makeChildPageSlashItem,
  makeSyncedBlockSlashItem,
} from './lib/slash-items';
export type {
  EditorProps,
  CollabConfig,
  SyncedBlockProps,
  MentionItem,
  MentionSource,
  SlashItem,
} from './lib/types';
