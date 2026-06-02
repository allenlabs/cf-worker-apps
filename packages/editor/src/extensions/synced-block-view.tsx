import { NodeViewWrapper, useEditor, EditorContent, type Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NodeViewProps } from '@tiptap/react';
import { syncRoom, type SyncedBlockOptions } from './synced-block';

/** Deterministic pastel cursor color from a name (mirrors CollaborativeEditor). */
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 55%)`;
}

/**
 * The nested editor for a synced block. Each instance binds its OWN Yjs doc to
 * room `sync-<syncId>` over the same y-websocket server the page uses, so all
 * instances of the same syncId mirror live. Deliberately a TRIMMED schema —
 * StarterKit (minus history, which conflicts with Yjs) plus marks/lists — and
 * NOT the SyncedBlock node itself, so synced blocks can never nest into one
 * another (no infinite recursion).
 */
export function SyncedBlockView(props: NodeViewProps) {
  const options = props.extension.options as SyncedBlockOptions;
  const { config, editable } = options;
  const syncId = (props.node.attrs.syncId as string) || '';
  const room = syncId ? syncRoom(syncId) : '';

  const ydocRef = useRef<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);

  // Connect the nested doc to its room (client only). The token is minted on
  // demand for THIS room, then the provider connects. Tear everything down on
  // unmount / room change so we never leak a socket or a Y.Doc.
  useEffect(() => {
    if (!config || !room) return;
    let cancelled = false;
    let p: WebsocketProvider | null = null;
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    void (async () => {
      let token: string;
      try {
        token = await config.roomToken(room);
      } catch {
        // Token mint failed — leave the block in its "connecting" state rather
        // than wedging the parent editor.
        return;
      }
      if (cancelled) {
        ydoc.destroy();
        return;
      }
      p = new WebsocketProvider(config.collabUrl, room, ydoc, { params: { token } });
      setProvider(p);
    })();
    return () => {
      cancelled = true;
      p?.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      setProvider(null);
    };
    // Reconnect only when the room (syncId) or collab url changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room, config?.collabUrl]);

  const extensions = useMemo<Extensions>(() => {
    const ext: Extensions = [
      StarterKit.configure({ history: false, heading: { levels: [1, 2, 3] } }),
      Underline,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: 'ae-link' } }),
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      TaskList,
      TaskItem.configure({ nested: true }),
    ];
    if (provider && ydocRef.current) {
      ext.push(Collaboration.configure({ document: ydocRef.current }));
      ext.push(
        CollaborationCursor.configure({
          provider,
          user: config
            ? { name: config.user.name, color: config.user.color ?? colorFor(config.user.name) }
            : { name: 'user', color: colorFor('user') },
        }),
      );
    }
    return ext;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const editor = useEditor(
    {
      extensions,
      editable,
      // Yjs is the source of truth in collab mode; no seed content.
      content: undefined,
      immediatelyRender: false,
    },
    [extensions, editable],
  );

  // No collab wiring (e.g. read-only HTML preview / SSR) → render a static
  // placeholder so the block is still visible and round-trips.
  if (!config || !room) {
    return (
      <NodeViewWrapper
        className="ae-synced-block"
        data-type="synced-block"
        data-testid="synced-block"
        data-sync-id={syncId}
      >
        <span className="ae-synced-badge" contentEditable={false}>
          Synced
        </span>
        <div className="ae-synced-body ae-synced-placeholder" contentEditable={false} />
      </NodeViewWrapper>
    );
  }

  return (
    <NodeViewWrapper
      className="ae-synced-block"
      data-type="synced-block"
      data-testid="synced-block"
      data-sync-id={syncId}
    >
      <span className="ae-synced-badge" contentEditable={false}>
        {options.badgeLabel ?? 'Synced'}
      </span>
      {provider && editor ? (
        <EditorContent editor={editor} className="ae-synced-body" />
      ) : (
        <div className="ae-synced-body ae-synced-connecting" contentEditable={false}>
          …
        </div>
      )}
    </NodeViewWrapper>
  );
}
