// Trash route (Phase 4). Lists archived pages for the current workspace with
// Restore + Delete-forever (purge) actions. Purge confirms first. After a
// structural change we full-page-reload the route so SSR re-reads the cookie
// and the sidebar/tree stay consistent (established repo lesson).

import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { Sidebar } from '~/components/Sidebar';
import {
  getTree,
  listWorkspaces,
  pageRestore,
  pagePurge,
  pagesTrash,
  sharedWithMe as sharedWithMeFn,
  teamspacesList,
  type PageNode,
  type SharedWithMeItem,
  type Teamspace,
  type TrashItem,
  type Workspace,
} from '~/server/docs';

export const Route = createFileRoute('/trash')({
  validateSearch: (search: Record<string, unknown>): { ws?: string } => ({
    ws: typeof search.ws === 'string' ? search.ws : undefined,
  }),
  beforeLoad: async () => {
    if (typeof document !== 'undefined') return;
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    if (!user) throw redirect({ to: '/auth/login' });
  },
  loaderDeps: ({ search }) => ({ ws: search.ws }),
  loader: async ({ deps }) => {
    if (typeof document !== 'undefined') {
      return {
        workspaces: [] as Workspace[],
        workspaceId: '',
        pages: [] as PageNode[],
        trash: [] as TrashItem[],
        teamspaces: [] as Teamspace[],
        sharedWithMe: [] as SharedWithMeItem[],
      };
    }
    const workspaces = await listWorkspaces();
    const workspaceId =
      (deps.ws && workspaces.some((w) => w.id === deps.ws) ? deps.ws : workspaces[0]?.id) ?? '';
    if (!workspaceId) {
      return {
        workspaces,
        workspaceId: '',
        pages: [] as PageNode[],
        trash: [] as TrashItem[],
        teamspaces: [] as Teamspace[],
        sharedWithMe: [] as SharedWithMeItem[],
      };
    }
    const [pages, trash, teamspaces, shared] = await Promise.all([
      getTree({ data: { workspaceId } }),
      pagesTrash({ data: { workspaceId } }),
      teamspacesList({ data: { workspaceId } }),
      sharedWithMeFn(),
    ]);
    return { workspaces, workspaceId, pages, trash, teamspaces, sharedWithMe: shared };
  },
  component: TrashPage,
});

function TrashPage() {
  const { workspaces, workspaceId, pages, trash, teamspaces, sharedWithMe } =
    Route.useLoaderData();
  const { t } = useT();
  const [busy, setBusy] = useState(false);

  async function handleRestore(id: string) {
    if (busy) return;
    setBusy(true);
    try {
      await pageRestore({ data: { id } });
      window.location.href = `/p/${id}`;
    } catch {
      setBusy(false);
    }
  }

  async function handlePurge(item: TrashItem) {
    if (busy) return;
    const ok = window.confirm(
      t('trash.purgeConfirm', { title: item.title || t('sidebar.untitled') }),
    );
    if (!ok) return;
    setBusy(true);
    try {
      await pagePurge({ data: { id: item.id } });
      window.location.reload();
    } catch {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] -mx-4 -my-6">
      <Sidebar
        workspaces={workspaces}
        workspaceId={workspaceId}
        pages={pages}
        teamspaces={teamspaces}
        sharedWithMe={sharedWithMe}
      />
      <div className="flex-1 overflow-y-auto p-8">
        <div className="max-w-2xl mx-auto">
          <h1 className="text-xl font-semibold mb-1">{t('trash.title')}</h1>
          <p className="text-sm text-gray-500 mb-6">{t('trash.body')}</p>
          {trash.length === 0 ? (
            <p className="text-sm text-gray-400">{t('trash.empty')}</p>
          ) : (
            <ul className="divide-y divide-gray-100 border border-gray-200 rounded">
              {trash.map((item) => (
                <li key={item.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <span className="shrink-0">{item.icon ?? '📄'}</span>
                  <span className="flex-1 truncate text-gray-800">
                    {item.title || t('sidebar.untitled')}
                  </span>
                  <button
                    className="text-gray-600 hover:text-gray-900"
                    onClick={() => void handleRestore(item.id)}
                    disabled={busy}
                  >
                    {t('trash.restore')}
                  </button>
                  <button
                    className="text-red-600 hover:text-red-800"
                    onClick={() => void handlePurge(item)}
                    disabled={busy}
                  >
                    {t('trash.deleteForever')}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
