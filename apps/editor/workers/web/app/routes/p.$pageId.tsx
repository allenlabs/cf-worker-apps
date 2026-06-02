import { createFileRoute, redirect } from '@tanstack/react-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { CollaborativeEditor } from '@allenlabs/editor';
import '@allenlabs/editor/styles.css';
import { Sidebar } from '~/components/Sidebar';
import { DatabaseView } from '~/components/DatabaseView';
import { CommentsPanel, type PendingThread } from '~/components/CommentsPanel';
import { VersionHistoryPanel } from '~/components/VersionHistoryPanel';
import { EmojiPicker } from '~/components/EmojiPicker';
import { PageCover } from '~/components/PageCover';
import {
  collabToken,
  createPage,
  dbSchema as dbSchemaFn,
  favList,
  favToggle,
  getPage,
  getTree,
  listWorkspaces,
  pageShares as pageSharesFn,
  searchMentions,
  setPublic as setPublicFn,
  setRestricted as setRestrictedFn,
  sharePage as sharePageFn,
  sharedWithMe as sharedWithMeFn,
  syncRoomToken,
  teamspacesList,
  unsharePage as unsharePageFn,
  updatePage,
  uploadFile,
  type CollabToken,
  type DbSchema,
  type FavoriteItem,
  type PageFull,
  type PageNode,
  type ShareRole,
  type SharedUser,
  type SharedWithMeItem,
  type Teamspace,
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
        teamspaces: [] as Teamspace[],
        sharedWithMe: [] as SharedWithMeItem[],
        shares: [] as SharedUser[],
        userName: '',
      };
    }
    const { getCurrentUser } = await import('~/server/auth-runtime.server');
    const user = await getCurrentUser();
    const page = await getPage({ data: { id: params.pageId } });
    const isDatabase = page.kind === 'database';
    // Database pages have no editor → skip the collab token; fetch the schema
    // (a row page is a normal page and still gets a collab editor).
    const [token, workspaces, pages, schema, favorites, teamspaces, shared, shares] =
      await Promise.all([
        isDatabase
          ? Promise.resolve(null as CollabToken | null)
          : collabToken({ data: { docId: params.pageId } }),
        listWorkspaces(),
        getTree({ data: { workspaceId: page.workspaceId } }),
        isDatabase
          ? dbSchemaFn({ data: { databaseId: params.pageId } })
          : Promise.resolve(null as DbSchema | null),
        favList(),
        teamspacesList({ data: { workspaceId: page.workspaceId } }),
        sharedWithMeFn(),
        pageSharesFn({ data: { pageId: params.pageId } }),
      ]);
    return {
      page,
      token,
      workspaces,
      pages,
      schema,
      favorites,
      teamspaces,
      sharedWithMe: shared,
      shares,
      userName: user?.name ?? 'user',
    };
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
  const {
    page,
    token,
    workspaces,
    pages,
    schema,
    favorites,
    teamspaces,
    sharedWithMe,
    shares: initialShares,
    userName,
  } = Route.useLoaderData();
  const { t } = useT();
  const { pageId } = Route.useParams();
  const isDatabase = page?.kind === 'database';
  // Phase 9: a viewer-only share resolves the page but the editor is read-only.
  const readOnly = page?.role === 'view';

  // TipTap touches the DOM — render the editor ONLY after mount (never on the
  // server). Until then show a skeleton.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const [title, setTitle] = useState(page?.title ?? 'Untitled');
  const [icon, setIcon] = useState(page?.icon ?? '');
  const [cover, setCover] = useState(page?.cover ?? null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Phase 4 header state: star, share popover, comments panel.
  const [favorited, setFavorited] = useState(page?.favorited ?? false);
  const [isPublic, setIsPublic] = useState(page?.public ?? false);
  // Phase 10: per-page restriction toggle (owner-only).
  const [restricted, setRestrictedState] = useState(page?.restricted ?? false);
  const isOwner = page?.role === 'owner';
  const [shareOpen, setShareOpen] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  // Inline-comment state: the open thread, a just-anchored (empty) thread, and
  // the threads the host has resolved/deleted (the editor strips their marks).
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [pendingThread, setPendingThread] = useState<PendingThread | null>(null);
  const [resolvedThreadIds, setResolvedThreadIds] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);
  const shareUrl = `${SHARE_BASE}${pageId}`;
  // Phase 9 invite state: the per-user shares list, the invite query + role.
  const [shares, setShares] = useState<SharedUser[]>(initialShares ?? []);
  const [inviteQuery, setInviteQuery] = useState('');
  const [inviteRole, setInviteRole] = useState<ShareRole>('view');
  const [inviting, setInviting] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  async function handleInvite() {
    const query = inviteQuery.trim();
    if (!query || inviting) return;
    setInviting(true);
    setInviteError(null);
    try {
      const added = await sharePageFn({ data: { pageId, query, role: inviteRole } });
      setShares((prev) => {
        const without = prev.filter((s) => s.userId !== added.userId);
        return [...without, added];
      });
      setInviteQuery('');
    } catch {
      setInviteError(t('share.noUser'));
    } finally {
      setInviting(false);
    }
  }

  async function handleUnshare(userId: string) {
    try {
      await unsharePageFn({ data: { pageId, userId } });
      setShares((prev) => prev.filter((s) => s.userId !== userId));
    } catch {
      /* ignore */
    }
  }

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

  async function handleToggleRestricted() {
    const next = !restricted;
    setRestrictedState(next);
    try {
      const res = await setRestrictedFn({ data: { id: pageId, restricted: next } });
      setRestrictedState(res.restricted);
    } catch {
      setRestrictedState(!next); // revert on failure
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

  // Inline comments: user anchored a fresh selection → open the panel on a new
  // (empty) thread; the first reply persists it under this threadId.
  function handleCommentCreate(threadId: string, selectedText: string) {
    setPendingThread({ threadId, context: selectedText });
    setActiveThreadId(threadId);
    setCommentsOpen(true);
  }

  // User clicked commented text → open the panel focused on that thread.
  function handleOpenThread(threadId: string) {
    setActiveThreadId(threadId);
    setCommentsOpen(true);
  }

  // A thread was resolved or fully deleted → tell the editor to strip its mark.
  function handleThreadResolved(threadId: string) {
    setResolvedThreadIds((ids) => (ids.includes(threadId) ? ids : [...ids, threadId]));
    setPendingThread((p) => (p?.threadId === threadId ? null : p));
  }

  function handleTitleBlur() {
    void updatePage({ data: { id: pageId, title: title.trim() || 'Untitled' } }).catch(() => {});
  }

  function handlePickIcon(emoji: string) {
    setIcon(emoji);
    setIconPickerOpen(false);
    void updatePage({ data: { id: pageId, icon: emoji } }).catch(() => {});
  }

  function handleRemoveIcon() {
    setIcon('');
    setIconPickerOpen(false);
    void updatePage({ data: { id: pageId, icon: null } }).catch(() => {});
  }

  function handleCoverChange(next: string | null) {
    setCover(next);
    void updatePage({ data: { id: pageId, cover: next } }).catch(() => {});
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
    return <div className="card p-8 text-gray-500">{t('page.loading')}</div>;
  }

  return (
    <div className="flex h-[calc(100vh-3rem)] -mx-4 -my-6">
      <Sidebar
        workspaces={workspaces}
        workspaceId={workspaceId}
        pages={pages}
        activePageId={pageId}
        favorites={favorites}
        teamspaces={teamspaces}
        sharedWithMe={sharedWithMe}
      />
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 py-6">
          <div className="flex items-center justify-end gap-1 mb-2 relative">
            <button
              className={`px-2 py-1 rounded text-sm hover:bg-gray-100 ${
                favorited ? 'text-yellow-500' : 'text-gray-400'
              }`}
              onClick={() => void handleToggleFav()}
              title={favorited ? t('page.favoriteRemove') : t('page.favoriteAdd')}
              aria-label={t('page.toggleFavorite')}
            >
              {favorited ? '★' : '☆'}
            </button>
            <button
              className="px-2 py-1 rounded text-sm text-gray-500 hover:bg-gray-100"
              onClick={() => setShareOpen((v) => !v)}
              aria-label={t('page.share')}
            >
              {t('page.share')}
            </button>
            <button
              className={`px-2 py-1 rounded text-sm hover:bg-gray-100 ${
                commentsOpen ? 'text-gray-900' : 'text-gray-500'
              }`}
              onClick={() => setCommentsOpen((v) => !v)}
              title={t('page.comments')}
              aria-label={t('page.toggleComments')}
            >
              💬
            </button>
            {isDatabase ? null : (
              <button
                className={`px-2 py-1 rounded text-sm hover:bg-gray-100 ${
                  historyOpen ? 'text-gray-900' : 'text-gray-500'
                }`}
                onClick={() => setHistoryOpen((v) => !v)}
                title={t('page.history')}
                aria-label={t('page.toggleHistory')}
              >
                {t('page.history')}
              </button>
            )}

            {shareOpen ? (
              <div className="absolute right-0 top-9 z-20 w-80 bg-white border border-gray-200 rounded shadow-lg p-3 text-sm">
                {/* Invite people (per-user sharing) */}
                <p className="text-gray-800 font-medium mb-1.5">{t('share.invitePeople')}</p>
                <div className="flex items-center gap-1 mb-1">
                  <input
                    className="flex-1 text-xs border border-gray-200 rounded px-2 py-1 outline-none focus:border-gray-400"
                    placeholder={t('share.invitePlaceholder')}
                    value={inviteQuery}
                    onChange={(e) => setInviteQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleInvite();
                      }
                    }}
                    aria-label={t('share.invitePeople')}
                  />
                  <select
                    className="text-xs border border-gray-200 rounded px-1 py-1 bg-white outline-none"
                    value={inviteRole}
                    onChange={(e) => setInviteRole(e.target.value as ShareRole)}
                    aria-label={t('share.invitePeople')}
                  >
                    <option value="view">{t('share.roleView')}</option>
                    <option value="edit">{t('share.roleEdit')}</option>
                  </select>
                  <button
                    className="text-xs px-2 py-1 border border-gray-200 rounded hover:bg-gray-100 disabled:opacity-50"
                    onClick={() => void handleInvite()}
                    disabled={inviting || !inviteQuery.trim()}
                  >
                    {inviting ? t('share.inviting') : t('share.invite')}
                  </button>
                </div>
                {inviteError ? (
                  <p className="text-xs text-red-600 mb-1">{inviteError}</p>
                ) : null}

                {shares.length > 0 ? (
                  <div className="mb-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400 mt-2 mb-1">
                      {t('share.peopleWithAccess')}
                    </p>
                    <ul className="space-y-1">
                      {shares.map((s) => (
                        <li key={s.userId} className="flex items-center gap-2 text-xs">
                          <span className="flex-1 truncate text-gray-800">{s.name}</span>
                          <span className="text-gray-400">
                            {s.role === 'edit' ? t('share.roleEdit') : t('share.roleView')}
                          </span>
                          <button
                            className="text-red-600 hover:text-red-800"
                            onClick={() => void handleUnshare(s.userId)}
                            aria-label={t('share.removeAria')}
                          >
                            {t('share.remove')}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {isOwner ? (
                  <div className="border-t border-gray-100 pt-2 mb-2">
                    <label className="flex items-center justify-between gap-2">
                      <span className="text-gray-800">{t('share.restrict')}</span>
                      <input
                        type="checkbox"
                        checked={restricted}
                        onChange={() => void handleToggleRestricted()}
                        aria-label={t('share.restrict')}
                      />
                    </label>
                    <p className="text-xs text-gray-400 mt-1">
                      {restricted ? t('share.restrictOn') : t('share.restrictOff')}
                    </p>
                  </div>
                ) : null}

                <div className="border-t border-gray-100 pt-2">
                  <label className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-gray-800">{t('share.toWeb')}</span>
                    <input
                      type="checkbox"
                      checked={isPublic}
                      onChange={() => void handleTogglePublic()}
                      aria-label={t('share.toWeb')}
                    />
                  </label>
                  {isPublic ? (
                    <div className="space-y-2">
                      <p className="text-xs text-gray-500">{t('share.anyoneCanView')}</p>
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
                          {copied ? t('share.copied') : t('share.copy')}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-gray-400">{t('share.off')}</p>
                  )}
                </div>
              </div>
            ) : null}
          </div>

          {ancestors.length > 0 ? (
            <nav className="text-xs text-gray-400 mb-4 flex flex-wrap items-center gap-1">
              {ancestors.map((a) => (
                <span key={a.id} className="flex items-center gap-1">
                  <a href={`/p/${a.id}`} className="no-underline hover:text-gray-600 hover:underline">
                    {a.icon ? `${a.icon} ` : ''}
                    {a.title || t('page.untitled')}
                  </a>
                  <span>/</span>
                </span>
              ))}
              <span className="text-gray-500">{title || t('page.untitled')}</span>
            </nav>
          ) : null}

          {readOnly ? (
            <p className="mb-3 px-3 py-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded">
              {t('page.readOnly')}
            </p>
          ) : null}

          <PageCover
            cover={cover}
            editable={!readOnly}
            uploadFile={uploadImageFile}
            onChange={handleCoverChange}
          />

          <div className="flex items-start gap-2 mb-2">
            <div className="relative">
              <button
                type="button"
                className="w-12 h-12 text-3xl flex items-center justify-center rounded hover:bg-gray-100 disabled:hover:bg-transparent"
                onClick={() => !readOnly && setIconPickerOpen((v) => !v)}
                disabled={readOnly}
                aria-label={icon ? t('icon.change') : t('icon.add')}
                title={icon ? t('icon.change') : t('icon.add')}
                data-testid="page-icon"
              >
                {icon || (readOnly ? '' : <span className="text-base text-gray-300">＋</span>)}
              </button>
              {iconPickerOpen && !readOnly ? (
                <EmojiPicker
                  onPick={handlePickIcon}
                  onRemove={handleRemoveIcon}
                  onClose={() => setIconPickerOpen(false)}
                />
              ) : null}
            </div>
            <input
              className="flex-1 text-3xl font-bold outline-none border-0 bg-transparent"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={handleTitleBlur}
              placeholder={t('page.untitled')}
              aria-label="Page title"
              readOnly={readOnly}
              data-testid="page-title"
            />
          </div>

          {isDatabase && schema ? (
            <DatabaseView
              databaseId={pageId}
              workspaceId={workspaceId}
              initialSchema={schema}
              editable={!readOnly}
            />
          ) : mounted && token ? (
            <div data-testid="editor">
            <CollaborativeEditor
              value={page.snapshotHtml}
              editable={!readOnly}
              placeholder={t('page.editorPlaceholder')}
              blockMenuT={t}
              collab={{
                url: token.url,
                docId: pageId,
                token: token.token,
                user: { name: userName },
              }}
              syncedBlock={{
                collabUrl: token.url,
                roomToken: async (room) => {
                  const t = await syncRoomToken({ data: { room } });
                  return t.token;
                },
                user: { name: userName },
              }}
              mention={async (q) => {
                const results = await searchMentions({ data: { q } });
                return results;
              }}
              uploadImage={uploadImageFile}
              onUpdate={handleUpdate}
              onCreateChildPage={async (childTitle) => {
                const created = await createPage({
                  data: { workspaceId, parentId: pageId, title: childTitle },
                });
                return { id: created.id, title: created.title };
              }}
              onOpenPage={(id) => {
                // Full-page nav per repo lesson (SSR re-reads the cookie).
                window.location.href = `/p/${id}`;
              }}
              comments={{
                onCreate: handleCommentCreate,
                onOpenThread: handleOpenThread,
                activeThreadId,
                resolvedThreadIds,
              }}
            />
            </div>
          ) : (
            <div className="text-gray-400 text-sm">{t('page.loadingEditor')}</div>
          )}

          {isDatabase || readOnly ? null : (
            <button
              className="mt-6 text-sm text-gray-500 hover:text-gray-800"
              onClick={handleNewSub}
            >
              {t('page.addSubPage')}
            </button>
          )}
        </div>
      </div>
      {commentsOpen ? (
        <CommentsPanel
          pageId={pageId}
          activeThreadId={activeThreadId}
          pendingThread={pendingThread}
          onClose={() => setCommentsOpen(false)}
          onThreadResolved={handleThreadResolved}
          onSelectThread={setActiveThreadId}
        />
      ) : null}
      {historyOpen && !isDatabase ? (
        <VersionHistoryPanel pageId={pageId} onClose={() => setHistoryOpen(false)} />
      ) : null}
    </div>
  );
}
