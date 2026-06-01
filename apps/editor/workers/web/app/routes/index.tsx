import { createFileRoute, Link, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { createDoc, listDocs, type DocListItem } from '~/server/docs';

export const Route = createFileRoute('/')({
  beforeLoad: async () => {
    // Server-only gate; bail out on the client (mock-proxy hang — see __root).
    if (typeof document !== 'undefined') return;
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    if (!user) throw redirect({ to: '/auth/login' });
  },
  loader: async () => {
    if (typeof document !== 'undefined') return { docs: [] as DocListItem[] };
    const docs = await listDocs();
    return { docs };
  },
  component: HomePage,
});

function HomePage() {
  const { docs } = Route.useLoaderData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleNew() {
    setBusy(true);
    setError(null);
    try {
      const created = await createDoc({ data: { title: 'Untitled' } });
      // Full-page nav so SSR re-reads the cookie and re-populates the user
      // (the client root loader can't see the httpOnly JWT). Mirrors PM.
      window.location.href = `/d/${created.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">My documents</h1>
        <button className="btn-primary" onClick={handleNew} disabled={busy}>
          {busy ? 'Creating…' : 'New document'}
        </button>
      </div>
      {error ? <p className="text-sm text-red-700 mb-3">{error}</p> : null}
      {docs.length === 0 ? (
        <div className="card p-8 text-center text-gray-500">
          No documents yet. Click “New document” to start writing.
        </div>
      ) : (
        <ul className="card divide-y divide-gray-100">
          {docs.map((d) => (
            <li key={d.id}>
              <Link
                to="/d/$docId"
                params={{ docId: d.id }}
                className="flex items-center justify-between px-4 py-3 no-underline hover:bg-editor-50"
              >
                <span className="font-medium text-gray-900">{d.title || 'Untitled'}</span>
                <span className="text-xs text-gray-400">
                  {new Date(d.updatedAt).toLocaleString()}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
