import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { CollaborativeEditor } from '@allenlabs/editor';
import '@allenlabs/editor/styles.css';
import {
  collabToken,
  getDoc,
  searchMentions,
  updateDoc,
  type CollabToken,
  type DocFull,
} from '~/server/docs';

export const Route = createFileRoute('/d/$docId')({
  beforeLoad: async () => {
    if (typeof document !== 'undefined') return;
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    if (!user) throw redirect({ to: '/auth/login' });
  },
  loader: async ({ params }) => {
    if (typeof document !== 'undefined') {
      return {
        doc: null as DocFull | null,
        token: null as CollabToken | null,
        userName: '',
      };
    }
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    const doc = await getDoc({ data: { id: params.docId } });
    const token = await collabToken({ data: { docId: params.docId } });
    return { doc, token, userName: user?.name ?? 'user' };
  },
  component: EditorPage,
});

function EditorPage() {
  const { doc, token, userName } = Route.useLoaderData();
  const { docId } = Route.useParams();

  // TipTap touches the DOM — render the editor ONLY after mount (never on the
  // server). Until then show a skeleton.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [title, setTitle] = useState(doc?.title ?? 'Untitled');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced snapshot save of the HTML to the backend.
  function handleUpdate(html: string) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void updateDoc({ data: { id: docId, snapshotHtml: html } }).catch(() => {});
    }, 800);
  }

  function handleTitleBlur() {
    void updateDoc({ data: { id: docId, title: title.trim() || 'Untitled' } }).catch(() => {});
  }

  if (!doc || !token) {
    return <div className="card p-8 text-gray-500">Loading…</div>;
  }

  return (
    <div className="card p-6">
      <input
        className="w-full text-2xl font-semibold mb-4 outline-none border-0 bg-transparent"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={handleTitleBlur}
        placeholder="Untitled"
      />
      {mounted ? (
        <CollaborativeEditor
          value={doc.snapshotHtml}
          placeholder='Type "/" for commands…'
          collab={{
            url: token.url,
            docId,
            token: token.token,
            user: { name: userName },
          }}
          mention={async (q) => {
            const results = await searchMentions({ data: { q } });
            return results;
          }}
          onUpdate={handleUpdate}
        />
      ) : (
        <div className="text-gray-400 text-sm">Loading editor…</div>
      )}
    </div>
  );
}
