import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { CollaborativeEditor } from '@allenlabs/editor';
import '@allenlabs/editor/styles.css';
import { Sidebar } from '~/components/Sidebar';
import { DatabaseView } from '~/components/DatabaseView';
import { CommentsPanel } from '~/components/CommentsPanel';
import { VersionHistoryPanel } from '~/components/VersionHistoryPanel';
import {
  collabToken,
  createPage,
  dbSchema as dbSchemaFn,
  favList,
  favToggle,
  getPage,
  getTree,
  listWorkspaces,
  searchMentions,
  setPublic as setPublicFn,
  updatePage,
  uploadFile,
  type CollabToken,
  type DbSchema,
  type FavoriteItem,
  type PageFull,
  type PageNode,
  type Workspace,
} from '~/server/docs';

const SHARE_BASE = 'https://editor.allenlabs.org/share/';

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
        favorites: [] as FavoriteItem[],
        userName: '',
      };
    }
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    const page = await getPage({ data: { id: params.pageId } });
    const isDatabase = page.kind === 'database';
    // Database pages have no editor → skip the collab token; fetch the schema
    // (a row page is a normal page and still gets a collab editor).
    const [token, workspaces, pages, schema, favorites] = await Promise.all([
      isDatabase
        ? Promise.resolve(null as CollabToken | null)
        : collabToken({ data: { docId: params.pageId } }),
      listWorkspaces(),
      getTree({ data: { workspaceId: page.workspaceId } }),
      isDatabase
        ? dbSchemaFn({ data: { databaseId: params.pageId } })
        : Promise.resolve(null as DbSchema | null),
      favList(),
    ]);
    return { page, token, workspaces, pages, schema, favorites, userName: user?.name ?? 'user' };
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
  const { page, token, workspaces, pages, schema, favorites, userName } = Route.useLoaderData();
  const { pageId } = Route.useParams();
  const isDatabase = page?.kind === 'database';

  // TipTap touches the DOM — render the editor ONLY after mount (never on the
  // server). Until then show a skeleton.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [title, setTitle] = useState(page?.title ?? 'Untitled');
  const [icon, setIcon] = useState(page?.icon ?? '');
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Phase 4 header state: star, share popover, comments panel.
  const [favorited, setFavorited] = useState(page?.favorited ?? false);
  const [isPublic, setIsPublic] = useState(page?.public ?? false);
  const [shareOpen, setShareOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const shareUrl = `${SHARE_BASE}${pageId}`;

  async function handleToggleFav() {
    try {
      const res = await favToggle({ data: { pageId } });
      setFavorited(res.favorited);
    } catch {
      /* ignore */
    }
  }

  async function handleTogglePublic() {
    const next = !isPublic;
    setIsPublic(next);
    try {
      const res = await setPublicFn({ data: { id: pageId, public: next } });
      setIsPublic(res.public);
    } catch {
      setIsPublic(!next); // revert on failure
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — clipboard may be unavailable */
    }
  }

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
        favorites={favorites}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-6">
          <div className="flex items-center justify-end gap-1 mb-2 relative">
            <button
              className={`px-2 py-1 rounded text-sm hover:bg-gray-100 ${
                favorited ? 'text-yellow-500' : 'text-gray-400'
              }`}
              onClick={() => void handleToggleFav()}
              title={favorited ? 'Remove from favorites' : 'Add to favorites'}
              aria-label="Toggle favorite"
            >
              {favorited ? '★' : '☆'}
            </button>
            <button
              className="px-2 py-1 rounded text-sm text-gray-500 hover:bg-gray-100"
              onClick={() => setShareOpen((v) => !v)}
              aria-label="Share"
            >
              Share
            </button>
            <button
              className={`px-2 py-1 rounded text-sm hover:bg-gray-100 ${
                commentsOpen ? 'text-gray-900' : 'text-gray-500'
              }`}
              onClick={() => setCommentsOpen((v) => !v)}
              title="Comments"
              aria-label="Toggle comments"
            >
              💬
            </button>
            {isDatabase ? null : (
              <button
                className={`px-2 py-1 rounded text-sm hover:bg-gray-100 ${
                  historyOpen ? 'text-gray-900' : 'text-gray-500'
                }`}
                onClick={() => setHistoryOpen((v) => !v)}
                title="Version history"
                aria-label="Toggle version history"
              >
                History
              </button>
            )}

            {shareOpen ? (
              <div className="absolute right-0 top-9 z-20 w-72 bg-white border border-gray-200 rounded shadow-lg p-3 text-sm">
                <label className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-gray-800">Share to web</span>
                  <input
                    type="checkbox"
                    checked={isPublic}
                    onChange={() => void handleTogglePublic()}
                    aria-label="Share to web"
                  />
                </label>
                {isPublic ? (
                  <div className="space-y-2">
                    <p className="text-xs text-gray-500">
                      Anyone with the link can view this page.
                    </p>
                    <div className="flex items-center gap-1">
                      <input
                        readOnly
                        className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 bg-gray-50"
                        value={shareUrl}
                        onFocus={(e) => e.currentTarget.select()}
                      />
                      <button
                        className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-100"
                        onClick={() => void handleCopyLink()}
                      >
                        {copied ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400">Off — only workspace members can view.</p>
                )}
              </div>
            ) : null}
          </div>

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
      {commentsOpen ? (
        <CommentsPanel pageId={pageId} onClose={() => setCommentsOpen(false)} />
      ) : null}
      {historyOpen && !isDatabase ? (
        <VersionHistoryPanel pageId={pageId} onClose={() => setHistoryOpen(false)} />
      ) : null}
    </div>
  );
}
