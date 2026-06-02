// Persistent left rail: workspace header (switcher when >1) + the recursive,
// collapsible page tree. Phase 9 adds:
//   • a "Shared with me" section (pages shared directly to the user that live
//     in a workspace they're not a member of),
//   • teamspace grouping of ROOT pages (collapsible sections; pages with no
//     teamspaceId fall under a default "Private" section),
//   • a "+ New teamspace" affordance.
//
// All page navigation is a full-page load — the client root loader returns
// user:null on client nav, so we use window.location to let SSR re-read the
// cookie and re-populate the user. (Established repo lesson.)

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import type {
  FavoriteItem,
  PageNode,
  SearchResult,
  SharedWithMeItem,
  Teamspace,
  TeamspaceMember,
  Workspace,
} from '~/server/docs';
import {
  createPage,
  dbCreate,
  search as searchFn,
  teamspaceCreate,
  teamspaceMemberAdd as teamspaceMemberAddFn,
  teamspaceMemberRemove as teamspaceMemberRemoveFn,
  teamspaceMembers as teamspaceMembersFn,
} from '~/server/docs';

interface TreeNode extends PageNode {
  children: TreeNode[];
}

/** Build a parent→children tree from the flat page array, ordered by position. */
export function buildTree(pages: PageNode[]): TreeNode[] {
  const byId = new Map<string, TreeNode>();
  for (const p of pages) byId.set(p.id, { ...p, children: [] });
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  }
  const sortRec = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.position - b.position);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** A teamspace section: the teamspace (null == default/Private) + its root nodes. */
export interface TeamspaceGroup {
  teamspace: Teamspace | null;
  roots: TreeNode[];
}

/**
 * Group root nodes by teamspaceId. Ungrouped roots (teamspaceId == null, or a
 * teamspaceId with no matching teamspace) fall under the default section. The
 * default section comes first, then teamspaces in their listed order.
 */
export function groupByTeamspace(roots: TreeNode[], teamspaces: Teamspace[]): TeamspaceGroup[] {
  const tsById = new Map(teamspaces.map((t) => [t.id, t]));
  const defaultRoots: TreeNode[] = [];
  const byTs = new Map<string, TreeNode[]>();
  for (const r of roots) {
    const tsId = r.teamspaceId && tsById.has(r.teamspaceId) ? r.teamspaceId : null;
    if (tsId === null) {
      defaultRoots.push(r);
    } else {
      const arr = byTs.get(tsId) ?? [];
      arr.push(r);
      byTs.set(tsId, arr);
    }
  }
  const groups: TeamspaceGroup[] = [{ teamspace: null, roots: defaultRoots }];
  for (const ts of teamspaces) {
    groups.push({ teamspace: ts, roots: byTs.get(ts.id) ?? [] });
  }
  return groups;
}

interface SidebarProps {
  workspaces: Workspace[];
  workspaceId: string;
  pages: PageNode[];
  activePageId?: string;
  favorites?: FavoriteItem[];
  teamspaces?: Teamspace[];
  sharedWithMe?: SharedWithMeItem[];
}

export function Sidebar({
  workspaces,
  workspaceId,
  pages,
  activePageId,
  favorites = [],
  teamspaces = [],
  sharedWithMe = [],
}: SidebarProps) {
  const { t } = useT();
  const tree = useMemo(() => buildTree(pages), [pages]);
  const groups = useMemo(() => groupByTeamspace(tree, teamspaces), [tree, teamspaces]);
  const [busy, setBusy] = useState(false);

  const current = workspaces.find((w) => w.id === workspaceId) ?? workspaces[0];

  async function handleNewRoot() {
    if (busy) return;
    setBusy(true);
    try {
      const created = await createPage({ data: { workspaceId, title: 'Untitled' } });
      window.location.href = `/p/${created.id}`;
    } catch {
      setBusy(false);
    }
  }

  async function handleNewDatabase() {
    if (busy) return;
    setBusy(true);
    try {
      const created = await dbCreate({ data: { workspaceId, title: 'Untitled database' } });
      // Full-page nav so SSR re-reads the cookie (established repo lesson).
      window.location.href = `/p/${created.id}`;
    } catch {
      setBusy(false);
    }
  }

  async function handleNewTeamspace() {
    if (busy) return;
    const name = window.prompt(t('sidebar.newTeamspacePrompt'), t('sidebar.newTeamspaceDefault'));
    if (name === null) return;
    setBusy(true);
    try {
      await teamspaceCreate({ data: { workspaceId, name: name.trim() || undefined } });
      // Full-page nav so SSR re-reads the cookie + the new teamspace section.
      window.location.href = `/?ws=${workspaceId}`;
    } catch {
      setBusy(false);
    }
  }

  function switchWorkspace(id: string) {
    if (id === workspaceId) return;
    window.location.href = `/?ws=${id}`;
  }

  return (
    <aside className="w-64 shrink-0 bg-gray-50 border-r border-gray-200 flex flex-col h-full">
      <div className="px-3 py-3 border-b border-gray-200">
        {workspaces.length > 1 ? (
          <select
            className="w-full text-sm font-semibold bg-transparent outline-none cursor-pointer"
            value={workspaceId}
            onChange={(e) => switchWorkspace(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-sm font-semibold text-gray-900">
            {current?.name ?? t('sidebar.workspace')}
          </span>
        )}
      </div>

      <div className="px-2 py-2 border-b border-gray-200">
        <SearchBox />
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {favorites.length > 0 ? (
          <div className="mb-2">
            <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {t('sidebar.favorites')}
            </p>
            <ul className="text-sm">
              {favorites.map((f) => (
                <li key={f.pageId}>
                  <a
                    href={`/p/${f.pageId}`}
                    className={`flex items-center gap-1 px-3 py-1 rounded no-underline text-gray-800 hover:bg-gray-100 ${
                      f.pageId === activePageId ? 'bg-gray-200 font-medium' : ''
                    }`}
                  >
                    <span className="shrink-0">{f.icon ?? '★'}</span>
                    <span className="truncate">{f.title || t('sidebar.untitled')}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {tree.length === 0 ? (
          <p className="px-3 py-2 text-xs text-gray-400">{t('sidebar.noPages')}</p>
        ) : (
          groups.map((g) => (
            <TeamspaceSection
              key={g.teamspace?.id ?? '__default'}
              group={g}
              workspaceId={workspaceId}
              activePageId={activePageId}
            />
          ))
        )}

        {sharedWithMe.length > 0 ? (
          <div className="mt-2">
            <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
              {t('sidebar.sharedWithMe')}
            </p>
            <ul className="text-sm">
              {sharedWithMe.map((s) => (
                <li key={s.id}>
                  <a
                    href={`/p/${s.id}`}
                    className={`flex items-center gap-1 px-3 py-1 rounded no-underline text-gray-800 hover:bg-gray-100 ${
                      s.id === activePageId ? 'bg-gray-200 font-medium' : ''
                    }`}
                  >
                    <span className="shrink-0">{s.icon ?? '📄'}</span>
                    <span className="truncate">{s.title || t('sidebar.untitled')}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </nav>

      <div className="px-2 py-2 border-t border-gray-200 space-y-0.5">
        <button
          className="w-full text-left px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
          onClick={handleNewRoot}
          disabled={busy}
          data-testid="new-page"
        >
          {t('sidebar.newPage')}
        </button>
        <button
          className="w-full text-left px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
          onClick={handleNewDatabase}
          disabled={busy}
        >
          {t('sidebar.newDatabase')}
        </button>
        <button
          className="w-full text-left px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
          onClick={handleNewTeamspace}
          disabled={busy}
        >
          {t('sidebar.newTeamspace')}
        </button>
        <a
          href={`/trash?ws=${workspaceId}`}
          className="block px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded no-underline"
        >
          {t('sidebar.trash')}
        </a>
      </div>
    </aside>
  );
}

interface TeamspaceSectionProps {
  group: TeamspaceGroup;
  workspaceId: string;
  activePageId?: string;
}

/** A collapsible teamspace section. The default (null) section shows "Private". */
function TeamspaceSection({ group, workspaceId, activePageId }: TeamspaceSectionProps) {
  const { t } = useT();
  const [open, setOpen] = useState(true);
  const [membersOpen, setMembersOpen] = useState(false);
  const ts = group.teamspace;
  const label = ts ? ts.name : t('sidebar.private');
  // Hide an empty default section so a brand-new workspace isn't cluttered, but
  // always show named teamspaces (so the user can find the place to add pages).
  if (ts === null && group.roots.length === 0) return null;
  return (
    <div className="mb-1">
      <div className="group flex items-center pr-2">
        <button
          className="flex-1 flex items-center gap-1 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <span className="w-3 inline-flex justify-center">{open ? '▾' : '▸'}</span>
          <span className="truncate">{label}</span>
        </button>
        {ts ? (
          <button
            className="opacity-0 group-hover:opacity-100 text-[11px] text-gray-400 hover:text-gray-700"
            onClick={() => setMembersOpen((v) => !v)}
            aria-label={t('sidebar.teamspaceMembers')}
            title={t('sidebar.teamspaceMembers')}
          >
            {t('sidebar.teamspaceMembersShort')}
          </button>
        ) : null}
      </div>
      {ts && membersOpen ? (
        <TeamspaceMembersPanel teamspace={ts} onClose={() => setMembersOpen(false)} />
      ) : null}
      {open ? (
        group.roots.length === 0 ? (
          <p className="px-6 py-1 text-xs text-gray-300">{t('sidebar.noPages')}</p>
        ) : (
          <ul className="text-sm">
            {group.roots.map((node) => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                workspaceId={workspaceId}
                activePageId={activePageId}
              />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

interface TeamspaceMembersPanelProps {
  teamspace: Teamspace;
  onClose: () => void;
}

/**
 * Compact teamspace-member manager (Phase 10). Lists members, adds by name /
 * username, and removes. With zero members a teamspace stays open to all
 * workspace members; once it has members, only members get access.
 */
function TeamspaceMembersPanel({ teamspace, onClose }: TeamspaceMembersPanelProps) {
  const { t } = useT();
  const [members, setMembers] = useState<TeamspaceMember[]>([]);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void teamspaceMembersFn({ data: { teamspaceId: teamspace.id } })
      .then((m) => {
        if (!cancelled) setMembers(m);
      })
      .catch(() => {
        if (!cancelled) setMembers([]);
      });
    return () => {
      cancelled = true;
    };
  }, [teamspace.id]);

  async function handleAdd() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      const added = await teamspaceMemberAddFn({ data: { teamspaceId: teamspace.id, query: q } });
      setMembers((prev) => [...prev.filter((m) => m.userId !== added.userId), added]);
      setQuery('');
    } catch {
      setError(t('share.noUser'));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(userId: string) {
    try {
      await teamspaceMemberRemoveFn({ data: { teamspaceId: teamspace.id, userId } });
      setMembers((prev) => prev.filter((m) => m.userId !== userId));
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="mx-3 mb-2 p-2 bg-white border border-gray-200 rounded text-xs shadow-sm">
      <div className="flex items-center justify-between mb-1">
        <span className="font-semibold text-gray-600">{t('sidebar.teamspaceMembers')}</span>
        <button className="text-gray-400 hover:text-gray-700" onClick={onClose} aria-label={t('sidebar.collapse')}>
          ✕
        </button>
      </div>
      <div className="flex items-center gap-1 mb-1">
        <input
          className="flex-1 border border-gray-200 rounded px-1.5 py-1 outline-none focus:border-gray-400"
          placeholder={t('share.invitePlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              void handleAdd();
            }
          }}
          aria-label={t('sidebar.teamspaceMembers')}
        />
        <button
          className="px-2 py-1 border border-gray-200 rounded hover:bg-gray-100 disabled:opacity-50"
          onClick={() => void handleAdd()}
          disabled={busy || !query.trim()}
        >
          {t('share.invite')}
        </button>
      </div>
      {error ? <p className="text-red-600 mb-1">{error}</p> : null}
      {members.length === 0 ? (
        <p className="text-gray-400">{t('sidebar.teamspaceOpen')}</p>
      ) : (
        <ul className="space-y-1">
          {members.map((m) => (
            <li key={m.userId} className="flex items-center gap-2">
              <span className="flex-1 truncate text-gray-800">{m.name}</span>
              <button
                className="text-red-600 hover:text-red-800"
                onClick={() => void handleRemove(m.userId)}
                aria-label={t('share.removeAria')}
              >
                {t('share.remove')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Debounced search box with a results dropdown; clicking a result navigates. */
function SearchBox() {
  const { t } = useT();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = q.trim();
    if (!term) {
      setResults([]);
      setOpen(false);
      return;
    }
    timer.current = setTimeout(() => {
      void searchFn({ data: { q: term } })
        .then((r) => {
          setResults(r);
          setOpen(true);
        })
        .catch(() => {
          setResults([]);
        });
    }, 250);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [q]);

  return (
    <div className="relative">
      <input
        className="w-full text-sm bg-white border border-gray-200 rounded px-2 py-1 outline-none focus:border-gray-400"
        placeholder={t('sidebar.searchPlaceholder')}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => {
          if (results.length > 0) setOpen(true);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label={t('sidebar.searchAria')}
      />
      {open ? (
        <div className="absolute z-10 left-0 right-0 mt-1 bg-white border border-gray-200 rounded shadow-md max-h-72 overflow-y-auto">
          {results.length === 0 ? (
            <p className="px-3 py-2 text-xs text-gray-400">{t('sidebar.noResults')}</p>
          ) : (
            <ul className="text-sm">
              {results.map((r) => (
                <li key={r.id}>
                  <a
                    href={`/p/${r.id}`}
                    className="flex items-center gap-1 px-3 py-1.5 no-underline text-gray-800 hover:bg-gray-100"
                  >
                    <span className="shrink-0">{r.icon ?? '📄'}</span>
                    <span className="truncate">{r.title || t('sidebar.untitled')}</span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  workspaceId: string;
  activePageId?: string;
}

function TreeRow({ node, depth, workspaceId, activePageId }: TreeRowProps) {
  const { t } = useT();
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const hasChildren = node.children.length > 0;
  const active = node.id === activePageId;

  async function handleAddSub(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const created = await createPage({
        data: { workspaceId, parentId: node.id, title: 'Untitled' },
      });
      window.location.href = `/p/${created.id}`;
    } catch {
      setBusy(false);
    }
  }

  return (
    <li>
      <div
        className={`group flex items-center gap-1 pr-2 py-1 rounded cursor-pointer hover:bg-gray-100 ${
          active ? 'bg-gray-200 font-medium' : ''
        }`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
      >
        <button
          className="w-4 h-4 flex items-center justify-center text-gray-400 hover:text-gray-700"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) setOpen((v) => !v);
          }}
          aria-label={hasChildren ? (open ? t('sidebar.collapse') : t('sidebar.expand')) : undefined}
        >
          {hasChildren ? (open ? '▾' : '▸') : '·'}
        </button>
        <a
          href={`/p/${node.id}`}
          className="flex-1 min-w-0 flex items-center gap-1 no-underline text-gray-800 truncate"
        >
          <span className="shrink-0">
            {node.icon ?? (node.kind === 'database' ? '⊞' : '📄')}
          </span>
          <span className="truncate">{node.title || t('sidebar.untitled')}</span>
        </a>
        <button
          className="opacity-0 group-hover:opacity-100 w-4 h-4 text-gray-400 hover:text-gray-700"
          onClick={handleAddSub}
          disabled={busy}
          aria-label={t('sidebar.addSubPage')}
          title={t('sidebar.addSubPage')}
        >
          ＋
        </button>
      </div>
      {hasChildren && open ? (
        <ul>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              workspaceId={workspaceId}
              activePageId={activePageId}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
