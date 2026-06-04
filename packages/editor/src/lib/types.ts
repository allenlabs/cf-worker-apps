import type { Editor, Range } from '@tiptap/core';
import type { ButtonAction } from './actions';

/** A person who can be @-mentioned. */
export interface MentionItem {
  id: string;
  label: string;
}

/** Source of mention suggestions for a typed query. */
export type MentionSource = (query: string) => MentionItem[] | Promise<MentionItem[]>;

/**
 * The set of AI actions the editor's AI affordances can request. The host's
 * {@link EditorProps.askAI} hook maps each to a prompt server-side (the package
 * never talks to an LLM). `custom` carries a free-form `instruction`;
 * `translate` carries a `targetLang`.
 */
export type AiAction =
  | 'summarize'
  | 'improve_writing'
  | 'fix_grammar'
  | 'make_shorter'
  | 'make_longer'
  | 'continue_writing'
  | 'translate'
  | 'change_tone'
  | 'explain'
  | 'custom';

/** Input passed to {@link EditorProps.askAI}. */
export interface AiAssistInput {
  /** Which transformation to apply. */
  action: AiAction;
  /** The text the action operates on (the selection, or preceding text for
   * `continue_writing`, or '' for a pure-instruction `custom` at the cursor). */
  text: string;
  /** Optional surrounding context (e.g. preceding paragraph) the host may
   * forward to the model. */
  context?: string;
  /** Free-form instruction for the `custom` action (the user's typed prompt). */
  instruction?: string;
  /** Target language for the `translate` action (e.g. 'English', 'Korean'). */
  targetLang?: string;
  /** Tone for the `change_tone` action (e.g. 'professional', 'casual'). */
  tone?: string;
}

/** One entry in the "/" slash menu. */
export interface SlashItem {
  title: string;
  /** Leading icon/emoji glyph shown left of the title (light visual cue). */
  icon?: string;
  /** Short hint shown under the title. */
  hint?: string;
  /** Words used to match the typed query (besides the title). */
  keywords?: string[];
  /** Mutate the doc when chosen. Range covers the typed "/query". */
  command: (props: { editor: Editor; range: Range }) => void;
}

/**
 * Inline (text-anchored) comment wiring. When set, the editor includes the
 * Comment mark, shows a "💬" button in the bubble toolbar on a non-empty
 * selection, and reports clicks on commented text. The thread's messages live
 * in the host's store keyed by `threadId`; the anchor (mark) lives in the doc
 * and syncs via Yjs.
 */
export interface CommentConfig {
  /**
   * Called when the user comments a fresh selection. A `threadId` has already
   * been generated and the mark applied; the host opens a thread UI for it and
   * persists the first message under this id.
   */
  onCreate: (threadId: string, selectedText: string) => void;
  /** Called when the user clicks text already anchored to a thread. */
  onOpenThread: (threadId: string) => void;
  /** The thread currently open in the host UI — rendered with a stronger highlight. */
  activeThreadId?: string | null;
  /**
   * Threads the host has resolved/deleted. The editor reacts by unsetting the
   * comment mark for each id (removing the anchor) — pass the full current set
   * each render; newly-added ids are cleared.
   */
  resolvedThreadIds?: string[];
}

/**
 * Synced-block wiring. When set, the editor registers the `syncedBlock` node + a
 * "Synced block" slash item: choosing it inserts a block bound to a fresh
 * `sync-<uuid>` room. Each block mounts a nested collaborative editor against
 * that room, so every instance of the same syncId (on any page) mirrors live.
 *
 * Reuses the page's collab transport: `collabUrl` is the same y-websocket base
 * as {@link CollabConfig.url}; `roomToken` mints a short-lived token for an
 * arbitrary room string (e.g. `sync-<uuid>`).
 */
export interface SyncedBlockProps {
  /** y-websocket base — the same one used for the page's collab. */
  collabUrl: string;
  /** Mint a short-lived token for a room string (resolved on NodeView mount). */
  roomToken: (room: string) => Promise<string>;
  /** Local user for the nested editor's awareness cursor. */
  user: { name: string; color?: string };
}

/** Real-time collaboration wiring. Omit for a plain single-user editor. */
export interface CollabConfig {
  /** y-websocket base, e.g. wss://host/editor (doc id is appended). */
  url: string;
  /** Document id — namespace however you like (e.g. "pm-issue-42"). */
  docId: string;
  /**
   * Short-lived auth token for the WS upgrade. A string, or a function that
   * returns one (resolved before connecting) so callers can mint on demand.
   */
  token: string | (() => string | Promise<string>);
  /** Local user shown to others via the awareness cursor. */
  user: { name: string; color?: string };
}

export interface EditorProps {
  /** Initial HTML for single-user mode. Ignored when `collab` is set (Yjs is
   * the source of truth there). */
  value?: string;
  editable?: boolean;
  placeholder?: string;
  collab?: CollabConfig;
  mention?: MentionSource;
  /**
   * Upload an image file and resolve to its public URL. Wired into paste/drop
   * and the "Image" slash item. If omitted, images can only be added by URL.
   */
  uploadImage?: (file: File) => Promise<string>;
  /**
   * Upload an arbitrary file and resolve to its public URL + name. Wired into
   * the "Video" / "Audio" / "File" slash items (each opens a file picker, then
   * inserts the matching media node). If omitted, those blocks fall back to a
   * URL prompt.
   */
  uploadFile?: (file: File) => Promise<{ url: string; name: string }>;
  /**
   * Breadcrumb trail for the "Breadcrumb" block — the page's ancestors
   * (root → parent), supplied by the host from the page tree. Clicking a crumb
   * routes through {@link EditorProps.onOpenPage}. Omit to render a "Top level"
   * placeholder.
   */
  breadcrumb?: { items: { id: string; title: string }[] };
  /** Called with the current HTML on every change (for snapshotting to a DB). */
  onUpdate?: (html: string) => void;
  /** Inline comments. Omit to disable the Comment mark + bubble button entirely. */
  comments?: CommentConfig;
  /**
   * Create a sub-page from the editor. When set, the editor registers the
   * `childPage` node + a "Page" slash item: choosing it calls this with the
   * seed title, then inserts a clickable child-page block with the returned id.
   */
  onCreateChildPage?: (title: string) => Promise<{ id: string; title: string; icon?: string }>;
  /**
   * Navigate to a page. Called when a child-page block is clicked (so the host
   * routes via its own router / full-page nav rather than the raw href).
   */
  onOpenPage?: (pageId: string) => void;
  /**
   * Pick an existing database to embed as a LINKED database view (Phase 15).
   * When set, the editor registers the `linkedDatabase` node + a "Linked
   * database view" slash item: choosing it calls this (the host shows a picker),
   * then inserts a clickable linked-database card referencing the chosen DB
   * (which is NOT moved). Resolve null to cancel. Clicking the card routes
   * through {@link EditorProps.onOpenPage}.
   */
  onPickLinkedDatabase?: () => Promise<{
    databaseId: string;
    title?: string;
    viewId?: string | null;
  } | null>;
  /**
   * Synced blocks. When set, the editor registers the `syncedBlock` node + a
   * "Synced block" slash item; each block mounts a nested collaborative editor
   * bound to its own `sync-<uuid>` room (mirrored across every page it appears
   * on). Omit to disable synced blocks entirely.
   */
  syncedBlock?: SyncedBlockProps;
  /**
   * Button blocks (Phase 17). When set, the editor registers the `button` node +
   * a "Button" slash item. Clicking a button runs its action list: client
   * actions (insert_blocks, open_page, show_confirm) run in the NodeView;
   * DATA actions (add_page_to_db, edit_pages) are delegated here so the host can
   * call its server fns. Omit to disable button blocks entirely (existing button
   * nodes still render + run their client-only actions when `onOpenPage` is set).
   */
  runButtonAction?: (action: ButtonAction) => Promise<void>;
  /**
   * AI assist hook (Notion-style "Ask AI"). When set, the editor renders an
   * "✨ AI" button in the bubble toolbar on a non-empty selection (opening a
   * menu of actions: summarize / improve / fix grammar / shorter / longer /
   * translate / change tone / explain) and an "Ask AI" + "Continue writing"
   * slash item. Each affordance calls this hook and offers Replace / Insert
   * below / Discard on the result.
   *
   * The PACKAGE NEVER calls an LLM or any network itself — the HOST implements
   * this (server fn → editor-api `/v1/ai` → LLM gateway), exactly like
   * {@link EditorProps.uploadImage}. If omitted, no AI affordances render.
   */
  askAI?: (input: AiAssistInput) => Promise<string>;
  /**
   * Translate AI menu labels (the "✨ AI" button + action names + result
   * actions). Receives an i18n key (e.g. `ai.summarize`), returns the localized
   * string. Omit for English defaults.
   */
  aiT?: (key: string) => string;
  /**
   * Show the ⋮⋮ block drag handle + block action menu (Notion editing feel).
   * Defaults to true; set false to opt out (e.g. a minimal embed). The handle
   * never appears in read-only mode regardless of this flag.
   */
  enableDragHandle?: boolean;
  /**
   * Translate block-menu labels (Turn into / Duplicate / Delete / Color / block
   * type names + tints). Receives an i18n key, returns the localized string.
   * Omit for English defaults.
   */
  blockMenuT?: (key: string) => string;
  className?: string;
}
