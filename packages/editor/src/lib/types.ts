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
  className?: string;
}
