import type { Editor, Range } from '@tiptap/core';

/** A person who can be @-mentioned. */
export interface MentionItem {
  id: string;
  label: string;
}

/** Source of mention suggestions for a typed query. */
export type MentionSource = (query: string) => MentionItem[] | Promise<MentionItem[]>;

/** One entry in the "/" slash menu. */
export interface SlashItem {
  title: string;
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
  /** Called with the current HTML on every change (for snapshotting to a DB). */
  onUpdate?: (html: string) => void;
  /** Inline comments. Omit to disable the Comment mark + bubble button entirely. */
  comments?: CommentConfig;
  className?: string;
}
