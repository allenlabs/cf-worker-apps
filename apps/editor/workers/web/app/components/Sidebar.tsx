// Persistent left rail: workspace header (switcher when >1) + the recursive,
// collapsible page tree. All page navigation is a full-page load — the client
// root loader returns user:null on client nav, so we use window.location to let
// SSR re-read the cookie and re-populate the user. (Established repo lesson.)

import { useMemo, useState } from 'react';
import type { PageNode, Workspace } from '~/server/docs';
import { createPage, dbCreate } from '~/server/docs';

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

interface SidebarProps {
  workspaces: Workspace[];
  workspaceId: string;
  pages: PageNode[];
  activePageId?: string;
}

export function Sidebar({ workspaces, workspaceId, pages, activePageId }: SidebarProps) {
  const tree = useMemo(() => buildTree(pages), [pages]);
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
          <span className="text-sm font-semibold text-gray-900">{current?.name ?? 'Workspace'}</span>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-2">
        {tree.length === 0 ? (
          <p className="px-3 py-2 text-xs text-gray-400">No pages yet.</p>
        ) : (
          <ul className="text-sm">
            {tree.map((node) => (
              <TreeRow
                key={node.id}
                node={node}
                depth={0}
                workspaceId={workspaceId}
                activePageId={activePageId}
              />
            ))}
          </ul>
        )}
      </nav>

      <div className="px-2 py-2 border-t border-gray-200 space-y-0.5">
        <button
          className="w-full text-left px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
          onClick={handleNewRoot}
          disabled={busy}
        >
          ＋ New page
        </button>
        <button
          className="w-full text-left px-2 py-1.5 text-sm text-gray-600 hover:bg-gray-100 rounded"
          onClick={handleNewDatabase}
          disabled={busy}
        >
          ⊞ New database
        </button>
      </div>
    </aside>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  workspaceId: string;
  activePageId?: string;
}

function TreeRow({ node, depth, workspaceId, activePageId }: TreeRowProps) {
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
          aria-label={hasChildren ? (open ? 'Collapse' : 'Expand') : undefined}
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
          <span className="truncate">{node.title || 'Untitled'}</span>
        </a>
        <button
          className="opacity-0 group-hover:opacity-100 w-4 h-4 text-gray-400 hover:text-gray-700"
          onClick={handleAddSub}
          disabled={busy}
          aria-label="Add sub-page"
          title="Add sub-page"
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
