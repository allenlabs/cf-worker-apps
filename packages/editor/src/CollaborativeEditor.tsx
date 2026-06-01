import { useEditor, EditorContent, type Extensions } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import { TextStyle } from '@tiptap/extension-text-style';
import { Color } from '@tiptap/extension-color';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableHeader from '@tiptap/extension-table-header';
import TableCell from '@tiptap/extension-table-cell';
import Collaboration from '@tiptap/extension-collaboration';
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SlashCommand } from './extensions/slash';
import { makeMention } from './extensions/mention';
import { Callout } from './extensions/callout';
import { Toggle, ToggleSummary } from './extensions/toggle';
import { Bookmark } from './extensions/bookmark';
import { Columns, Column } from './extensions/columns';
import { Comment, commentThreadIdAt } from './extensions/comment';
import { BubbleToolbar } from './extensions/bubble-toolbar';
import { DEFAULT_SLASH_ITEMS } from './lib/slash-items';
import type { EditorProps, SlashItem } from './lib/types';

/** Deterministic pastel cursor color from a name, so a user is the same hue
 * for everyone without coordinating a palette. */
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 55%)`;
}

/** An editor handle narrow enough for the image helpers (avoids importing the
 * full TipTap Editor type just for `chain().setImage`). */
type ImageEditor = {
  chain: () => { focus: () => { setImage: (a: { src: string }) => { run: () => boolean } } };
};

/** Upload a file then insert it as an image node. Swallows failures so a bad
 * upload never wedges the editor. */
async function insertUploadedImage(
  editor: ImageEditor,
  upload: (file: File) => Promise<string>,
  file: File,
): Promise<void> {
  try {
    const url = await upload(file);
    editor.chain().focus().setImage({ src: url }).run();
  } catch {
    /* upload failed — leave the doc untouched */
  }
}

/** Open a hidden file picker, then upload + insert the chosen image. */
function pickAndUploadImage(
  editor: ImageEditor,
  upload: (file: File) => Promise<string>,
): void {
  if (typeof document === 'undefined') return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (file) void insertUploadedImage(editor, upload, file);
    input.remove();
  });
  document.body.appendChild(input);
  input.click();
}

/** First image file in a clipboard/drag payload, if any. */
function imageFileFrom(data: DataTransfer | null): File | null {
  if (!data) return null;
  for (const item of Array.from(data.files)) {
    if (item.type.startsWith('image/')) return item;
  }
  return null;
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

  const { uploadImage } = props;

  // Slash items: clone the defaults and, when an uploader is wired, swap the
  // "Image" item's command for a hidden-file-input upload flow.
  const slashItems = useMemo<SlashItem[]>(() => {
    if (!uploadImage) return DEFAULT_SLASH_ITEMS;
    return DEFAULT_SLASH_ITEMS.map((it) =>
      it.title === 'Image'
        ? {
            ...it,
            command: ({ editor, range }) => {
              editor.chain().focus().deleteRange(range).run();
              pickAndUploadImage(editor, uploadImage);
            },
          }
        : it,
    );
  }, [uploadImage]);

  const extensions = useMemo<Extensions>(() => {
    const ext: Extensions = [
      // History conflicts with Yjs undo; disable it in collab mode.
      StarterKit.configure(collab ? { history: false } : {}),
      Placeholder.configure({
        placeholder: props.placeholder ?? 'Type "/" for commands, "@" to mention…',
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      // Marks + media.
      Underline,
      Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { class: 'ae-link' } }),
      Highlight.configure({ multicolor: true }),
      TextStyle,
      Color,
      Image.configure({ HTMLAttributes: { class: 'ae-image' } }),
      // Tables.
      Table.configure({ resizable: true }),
      TableRow,
      TableHeader,
      TableCell,
      // Custom blocks.
      Callout,
      Toggle,
      ToggleSummary,
      Bookmark,
      Columns,
      Column,
      SlashCommand.configure({ items: slashItems }),
    ];
    // Inline comments: a normal mark, so it rides through Yjs in collab mode.
    if (props.comments) ext.push(Comment);
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
    // Note: only `!!props.comments` matters for the extension list (the mark is
    // either present or not); the live handlers are read through refs below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab, provider, props.mention, props.placeholder, slashItems, !!props.comments]);

  // The paste/drop handlers need the editor instance, but it doesn't exist yet
  // when we build the config. A ref (kept current below) breaks that cycle.
  const editorRef = useRef<ImageEditor | null>(null);

  // Comment click → open thread. Kept in a ref so the (config-time) handleClick
  // closure always sees the latest callback without rebuilding the editor.
  const onOpenThreadRef = useRef<((threadId: string) => void) | null>(null);
  onOpenThreadRef.current = props.comments?.onOpenThread ?? null;

  const editor = useEditor(
    {
      extensions,
      editable: props.editable ?? true,
      content: collab ? undefined : props.value ?? '',
      immediatelyRender: false,
      editorProps: {
        // Paste/drop image files → upload → insert. Only intercept when there's
        // an actual image file and an uploader; otherwise fall through to the
        // default handlers (so pasting text/HTML still works).
        handlePaste: (_view, event) => {
          const ed = editorRef.current;
          if (!uploadImage || !ed) return false;
          const file = imageFileFrom(event.clipboardData);
          if (!file) return false;
          event.preventDefault();
          void insertUploadedImage(ed, uploadImage, file);
          return true;
        },
        handleDrop: (_view, event) => {
          const ed = editorRef.current;
          if (!uploadImage || !ed) return false;
          const file = imageFileFrom((event as DragEvent).dataTransfer);
          if (!file) return false;
          event.preventDefault();
          void insertUploadedImage(ed, uploadImage, file);
          return true;
        },
        // Click on commented text → open that thread. Returns false so the
        // click still positions the caret as usual.
        handleClick: (view, pos) => {
          const open = onOpenThreadRef.current;
          if (!open) return false;
          const threadId = commentThreadIdAt(view.state.doc, pos);
          if (threadId) open(threadId);
          return false;
        },
      },
      onUpdate: ({ editor }) => props.onUpdate?.(editor.getHTML()),
    },
    [extensions, props.editable],
  );
  editorRef.current = editor;

  // When the host resolves/deletes a thread, strip its anchor mark from the doc
  // (which syncs the removal to collaborators via Yjs). We track which ids we've
  // already cleared so re-renders with the same list don't fire repeatedly.
  const clearedThreadsRef = useRef<Set<string>>(new Set());
  const resolvedThreadIds = props.comments?.resolvedThreadIds;
  useEffect(() => {
    if (!editor || !resolvedThreadIds) return;
    for (const id of resolvedThreadIds) {
      if (clearedThreadsRef.current.has(id)) continue;
      clearedThreadsRef.current.add(id);
      editor.chain().unsetCommentThread(id).run();
    }
  }, [editor, resolvedThreadIds]);

  // Reflect the active thread as a `data-active` attribute on its spans so CSS
  // can highlight the open thread more strongly.
  const activeThreadId = props.comments?.activeThreadId ?? null;
  useEffect(() => {
    if (!editor || !props.comments) return;
    const root = editor.view.dom as HTMLElement;
    const apply = () => {
      root.querySelectorAll('span.ae-comment').forEach((el) => {
        const match = el.getAttribute('data-thread-id') === activeThreadId && activeThreadId;
        el.classList.toggle('ae-comment-active', Boolean(match));
      });
    };
    apply();
    // Re-apply after doc changes (spans get re-rendered by ProseMirror).
    editor.on('update', apply);
    return () => {
      editor.off('update', apply);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, activeThreadId, !!props.comments]);

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
    <>
      {editor ? <BubbleToolbar editor={editor} comments={props.comments} /> : null}
      <EditorContent
        editor={editor}
        className={props.className}
        data-testid="editor-content"
      />
    </>
  );
}
