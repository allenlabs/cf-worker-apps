import { Node, mergeAttributes, ReactNodeViewRenderer } from '@tiptap/react';
import { SyncedBlockView } from './synced-block-view';

/**
 * Build the Yjs room name for a synced block. A synced block's content lives in
 * its OWN room (separate from the page's room), keyed only by its syncId — so
 * every instance of the same syncId, on ANY page, binds the same room and edits
 * propagate live. Pure, so it's unit-tested independent of the runtime.
 */
export function syncRoom(syncId: string): string {
  return `sync-${syncId}`;
}

/** Wiring the SyncedBlock NodeView needs to connect its nested editor to collab. */
export interface SyncedBlockConfig {
  /** y-websocket base (same as the page's collab url). */
  collabUrl: string;
  /** Mint a short-lived token for an arbitrary room string (resolved on mount). */
  roomToken: (room: string) => Promise<string>;
  /** Local user for the awareness cursor inside the nested editor. */
  user: { name: string; color?: string };
}

export interface SyncedBlockOptions {
  /** Collab wiring; when null the NodeView renders a static placeholder. */
  config: SyncedBlockConfig | null;
  /** Whether the nested editor is editable (viewers → false). */
  editable: boolean;
  /** Localized label for the "Synced" badge. Defaults to English in the view. */
  badgeLabel?: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    syncedBlock: {
      /** Insert a synced block bound to the given (or a fresh) sync room. */
      setSyncedBlock: (attrs?: { syncId?: string }) => ReturnType;
    };
  }
}

/** Generate a fresh sync id (UUID v4). Falls back when crypto is unavailable. */
function freshSyncId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Extremely unlikely in a browser; keeps the node insertable in tests/SSR.
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * SyncedBlock — an atom block whose content is a SEPARATE Yjs document bound to
 * room `sync-<syncId>`. A React NodeView mounts a small nested collaborative
 * editor against that room, so every instance of the same syncId (on any page)
 * mirrors the same content in real time — the Notion synced-block semantic.
 *
 * It's an atom from the PARENT doc's perspective (the nested content is NOT in
 * the page's Yjs doc); we only persist `{ syncId }`. Serialises to
 * `<div data-type="synced-block" data-sync-id="…">` so it round-trips through
 * the page's HTML snapshot and the block menu's Duplicate copies the syncId —
 * making the copy sync with the original.
 */
export const SyncedBlock = Node.create<SyncedBlockOptions>({
  name: 'syncedBlock',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,

  addOptions() {
    return { config: null, editable: true, badgeLabel: undefined };
  },

  addAttributes() {
    return {
      syncId: {
        default: '',
        parseHTML: (el) => el.getAttribute('data-sync-id') ?? '',
        renderHTML: (attrs) => ({ 'data-sync-id': attrs.syncId as string }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="synced-block"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(HTMLAttributes, {
        'data-type': 'synced-block',
        'data-testid': 'synced-block',
        class: 'ae-synced-block',
      }),
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(SyncedBlockView);
  },

  addCommands() {
    return {
      setSyncedBlock:
        (attrs) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { syncId: attrs?.syncId || freshSyncId() },
          }),
    };
  },
});
