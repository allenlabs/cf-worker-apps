export { CollaborativeEditor } from './CollaborativeEditor';
export { SlashCommand } from './extensions/slash';
export { makeMention } from './extensions/mention';
export { Callout } from './extensions/callout';
export { Toggle, ToggleSummary } from './extensions/toggle';
export { Bookmark } from './extensions/bookmark';
export { Columns, Column } from './extensions/columns';
export { Comment, commentThreadIdAt } from './extensions/comment';
export { ChildPage, childPageLabel, CHILD_PAGE_DEFAULT_ICON } from './extensions/child-page';
export { BubbleToolbar } from './extensions/bubble-toolbar';
export {
  DEFAULT_SLASH_ITEMS,
  filterSlashItems,
  makeChildPageSlashItem,
} from './lib/slash-items';
export type {
  EditorProps,
  CollabConfig,
  MentionItem,
  MentionSource,
  SlashItem,
} from './lib/types';
