import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { Sidebar } from '~/components/Sidebar';
import {
  createPage,
  dbCreate,
  getTree,
  listWorkspaces,
  type PageNode,
  type Workspace,
} from '~/server/docs';

export const Route = createFileRoute('/')({
  validateSearch: (search: Record<string, unknown>): { ws?: string } => ({
    ws: typeof search.ws === 'string' ? search.ws : undefined,
  }),
  beforeLoad: async () => {
    // Server-only gate; bail out on the client (mock-proxy hang — see __root).
    if (typeof document !== 'undefined') return;
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    if (!user) throw redirect({ to: '/auth/login' });
  },
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ deps }) => {
    if (typeof document !== 'undefined') {
      return { workspaces: [] as Workspace[], workspaceId: '', pages: [] as PageNode[] };
    }
    const workspaces = await listWorkspaces();
    const workspaceId =
      (deps.ws && workspaces.some((w) => w.id === deps.ws) ? deps.ws : workspaces[0]?.id) ?? '';
    if (!workspaceId) {
      return { workspaces, workspaceId: '', pages: [] as PageNode[] };
    }
    const pages = await getTree({ data: { workspaceId } });
    // Redirect straight to the first page if the workspace already has one.
    const firstRoot = pages
      .filter((p) => p.parentId === null)
      .sort((a, b) => a.position - b.position)[0];
    if (firstRoot) {
      throw redirect({ to: '/p/$pageId', params: { pageId: firstRoot.id } });
    }
    return { workspaces, workspaceId, pages };
  },
  component: HomePage,
});

function HomePage() {
  const { workspaces, workspaceId, pages } = Route.useLoaderData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleNew() {
    setBusy(true);
    setError(null);
    try {
      const created = await createPage({ data: { workspaceId, title: 'Untitled' } });
      // Full-page nav so SSR re-reads the cookie and re-populates the user.
      window.location.href = `/p/${created.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  async function handleNewDatabase() {
    setBusy(true);
    setError(null);
    try {
      const created = await dbCreate({ data: { workspaceId, title: 'Untitled database' } });
      window.location.href = `/p/${created.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  }

  if (!workspaceId) {
    return (
      <div className="card p-8 text-center text-gray-500">Setting up your workspace…</div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] -mx-4 -my-6">
      <Sidebar workspaces={workspaces} workspaceId={workspaceId} pages={pages} />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-2xl mx-auto text-center mt-16">
          <h1 className="text-xl font-semibold mb-2">Create your first page</h1>
          <p className="text-gray-500 mb-6">
            Pages can be nested infinitely. Start with one and add sub-pages as you go.
          </p>
          {error ? <p className="text-sm text-red-700 mb-3">{error}</p> : null}
          <div className="flex items-center justify-center gap-2">
            <button className="btn-primary" onClick={handleNew} disabled={busy}>
              {busy ? 'Creating…' : 'New page'}
            </button>
            <button
              className="btn-primary"
              onClick={handleNewDatabase}
              disabled={busy}
            >
              {busy ? 'Creating…' : 'New database'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
