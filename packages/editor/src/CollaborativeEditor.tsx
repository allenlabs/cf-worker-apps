import { useEditor, EditorContent, type Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SlashCommand } from './extensions/slash';
import { makeMention } from './extensions/mention';
import type { EditorProps } from './lib/types';

/** Deterministic pastel cursor color from a name, so a user is the same hue
 * for everyone without coordinating a palette. */
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 55%)`;
}

/**
 * Collaborative, block-based rich-text editor.
 *
 * - No `collab`: single-user editor seeded from `value`.
 * - With `collab`: real-time multi-user over Yjs; the Yjs doc is the source of
 *   truth (so `value` is ignored), peers' carets show via the awareness cursor.
 *
 * SSR-safe: the editor only initialises in the browser (`immediatelyRender:
 * false`), so it's fine to render from an SSR framework as long as the host
 * route is client-hydrated.
 */
export function CollaborativeEditor(props: EditorProps) {
  const { collab } = props;
  const ydocRef = useRef<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);

  // Build the Yjs doc + websocket provider for collab mode (client only). The
  // token may be async, so we resolve it before connecting.
  useEffect(() => {
    if (!collab) return;
    let cancelled = false;
    let p: WebsocketProvider | null = null;
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;
    void (async () => {
      const token =
        typeof collab.token === 'function' ? await collab.token() : collab.token;
      if (cancelled) {
        ydoc.destroy();
        return;
      }
      p = new WebsocketProvider(collab.url, collab.docId, ydoc, {
        params: { token },
      });
      setProvider(p);
    })();
    return () => {
      cancelled = true;
      p?.destroy();
      ydoc.destroy();
      ydocRef.current = null;
      setProvider(null);
    };
    // Reconnect only when the room/url changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab?.url, collab?.docId]);

  const extensions = useMemo<Extensions>(() => {
    const ext: Extensions = [
      // History conflicts with Yjs undo; disable it in collab mode.
      StarterKit.configure(collab ? { history: false } : {}),
      Placeholder.configure({
        placeholder: props.placeholder ?? 'Type "/" for commands, "@" to mention…',
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      SlashCommand,
    ];
    if (props.mention) ext.push(makeMention(props.mention));
    if (collab && provider && ydocRef.current) {
      ext.push(Collaboration.configure({ document: ydocRef.current }));
      ext.push(
        CollaborationCursor.configure({
          provider,
          user: { name: collab.user.name, color: collab.user.color ?? colorFor(collab.user.name) },
        }),
      );
    }
    return ext;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab, provider, props.mention, props.placeholder]);

  const editor = useEditor(
    {
      extensions,
      editable: props.editable ?? true,
      content: collab ? undefined : props.value ?? '',
      immediatelyRender: false,
      onUpdate: ({ editor }) => props.onUpdate?.(editor.getHTML()),
    },
    [extensions, props.editable],
  );

  // In collab mode the editor can't initialise until the provider exists
  // (Collaboration extension needs the doc). Show a lightweight placeholder.
  if (collab && !provider) {
    return (
      <div className={props.className} data-testid="editor-connecting">
        <div className="ae-connecting">Connecting…</div>
      </div>
    );
  }

  return (
    <EditorContent
      editor={editor}
      className={props.className}
      data-testid="editor-content"
    />
  );
}
