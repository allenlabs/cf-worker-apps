import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CollaborativeEditor } from '@allenlabs/editor';
import '@allenlabs/editor/styles.css';
import { Sidebar } from '~/components/Sidebar';
import { DatabaseView } from '~/components/DatabaseView';
import {
  collabToken,
  createPage,
  dbSchema as dbSchemaFn,
  getPage,
  getTree,
  listWorkspaces,
  searchMentions,
  updatePage,
  uploadFile,
  type CollabToken,
  type DbSchema,
  type PageFull,
  type PageNode,
  type Workspace,
} from '~/server/docs';

/** Read a File to a bare base64 string (no data: prefix). */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      resolve(result.includes(',') ? result.slice(result.indexOf(',') + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Editor upload handler: File → base64 → server fn → public URL. */
async function uploadImageFile(file: File): Promise<string> {
  const dataBase64 = await fileToBase64(file);
  const { url } = await uploadFile({
    data: { filename: file.name, contentType: file.type, dataBase64 },
  });
  return url;
}

export const Route = createFileRoute('/p/$pageId')({
  beforeLoad: async () => {
    if (typeof document !== 'undefined') return;
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    if (!user) throw redirect({ to: '/auth/login' });
  },
  loader: async ({ params }) => {
    if (typeof document !== 'undefined') {
      return {
        page: null as PageFull | null,
        token: null as CollabToken | null,
        workspaces: [] as Workspace[],
        pages: [] as PageNode[],
        schema: null as DbSchema | null,
        userName: '',
      };
    }
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    const page = await getPage({ data: { id: params.pageId } });
    const isDatabase = page.kind === 'database';
    // Database pages have no editor → skip the collab token; fetch the schema
    // (a row page is a normal page and still gets a collab editor).
    const [token, workspaces, pages, schema] = await Promise.all([
      isDatabase
        ? Promise.resolve(null as CollabToken | null)
        : collabToken({ data: { docId: params.pageId } }),
      listWorkspaces(),
      getTree({ data: { workspaceId: page.workspaceId } }),
      isDatabase
        ? dbSchemaFn({ data: { databaseId: params.pageId } })
        : Promise.resolve(null as DbSchema | null),
    ]);
    return { page, token, workspaces, pages, schema, userName: user?.name ?? 'user' };
  },
  component: PageView,
});

/** Walk parent links from the flat tree to build an ancestor breadcrumb. */
function ancestorsOf(pages: PageNode[], pageId: string): PageNode[] {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const chain: PageNode[] = [];
  let cur = byId.get(pageId)?.parentId ?? null;
  const seen = new Set<string>();
  while (cur && byId.has(cur) && !seen.has(cur)) {
    seen.add(cur);
    const node = byId.get(cur)!;
    chain.unshift(node);
    cur = node.parentId;
  }
  return chain;
}

function PageView() {
  const { page, token, workspaces, pages, schema, userName } = Route.useLoaderData();
  const { pageId } = Route.useParams();
  const isDatabase = page?.kind === 'database';

  // TipTap touches the DOM — render the editor ONLY after mount (never on the
  // server). Until then show a skeleton.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [title, setTitle] = useState(page?.title ?? 'Untitled');
  const [icon, setIcon] = useState(page?.icon ?? '');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const ancestors = useMemo(() => ancestorsOf(pages, pageId), [pages, pageId]);
  const workspaceId = page?.workspaceId ?? '';

  function handleUpdate(html: string) {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void updatePage({ data: { id: pageId, snapshotHtml: html } }).catch(() => {});
    }, 800);
  }

  function handleTitleBlur() {
    void updatePage({ data: { id: pageId, title: title.trim() || 'Untitled' } }).catch(() => {});
  }

  function handleIconBlur() {
    const next = icon.trim();
    void updatePage({ data: { id: pageId, icon: next || null } }).catch(() => {});
  }

  async function handleNewSub() {
    try {
      const created = await createPage({ data: { workspaceId, parentId: pageId, title: 'Untitled' } });
      window.location.href = `/p/${created.id}`;
    } catch {
      /* ignore */
    }
  }

  // A database page has no collab token (no editor); a normal page needs one.
  if (!page || (!isDatabase && !token)) {
    return <div className="card p-8 text-gray-500">Loading…</div>;
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] -mx-4 -my-6">
      <Sidebar
        workspaces={workspaces}
        workspaceId={workspaceId}
        pages={pages}
        activePageId={pageId}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-6">
          {ancestors.length > 0 ? (
            <nav className="text-xs text-gray-400 mb-4 flex flex-wrap items-center gap-1">
              {ancestors.map((a) => (
                <span key={a.id} className="flex items-center gap-1">
                  <a href={`/p/${a.id}`} className="no-underline hover:text-gray-600 hover:underline">
                    {a.icon ? `${a.icon} ` : ''}
                    {a.title || 'Untitled'}
                  </a>
                  <span>/</span>
                </span>
              ))}
              <span className="text-gray-500">{title || 'Untitled'}</span>
            </nav>
          ) : null}

          <div className="flex items-start gap-2 mb-2">
            <input
              className="w-12 text-3xl text-center outline-none border-0 bg-transparent"
              value={icon}
              onChange={(e) => setIcon(e.target.value)}
              onBlur={handleIconBlur}
              placeholder="📄"
              maxLength={8}
              aria-label="Page icon"
            />
            <input
              className="flex-1 text-3xl font-bold outline-none border-0 bg-transparent"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              placeholder="Untitled"
              aria-label="Page title"
            />
          </div>

          {isDatabase && schema ? (
            <DatabaseView databaseId={pageId} initialSchema={schema} />
          ) : mounted && token ? (
            <CollaborativeEditor
              value={page.snapshotHtml}
              placeholder='Type "/" for commands…'
              collab={{
                url: token.url,
                docId: pageId,
                token: token.token,
                user: { name: userName },
              }}
              mention={async (q) => {
                const results = await searchMentions({ data: { q } });
                return results;
              }}
              uploadImage={uploadImageFile}
              onUpdate={handleUpdate}
            />
          ) : (
            <div className="text-gray-400 text-sm">Loading editor…</div>
          )}

          {isDatabase ? null : (
            <button
              className="mt-6 text-sm text-gray-500 hover:text-gray-800"
              onClick={handleNewSub}
            >
              ＋ Add sub-page
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
