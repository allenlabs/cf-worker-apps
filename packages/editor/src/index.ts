export { CollaborativeEditor } from './CollaborativeEditor';
export { SlashCommand } from './extensions/slash';
export { makeMention } from './extensions/mention';
export { Callout } from './extensions/callout';
export { Toggle, ToggleSummary } from './extensions/toggle';
export { Bookmark } from './extensions/bookmark';
export { Columns, Column } from './extensions/columns';
export { BubbleToolbar } from './extensions/bubble-toolbar';
export { DEFAULT_SLASH_ITEMS, filterSlashItems } from './lib/slash-items';
export type {
  EditorProps,
  CollabConfig,
  MentionItem,
  MentionSource,
  SlashItem,
} from './lib/types';
