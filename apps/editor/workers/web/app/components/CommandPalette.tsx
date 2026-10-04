// Phase 14: global ⌘K / Ctrl-K quick find. Mounted once from Layout so it's
// available on every page. Combines:
//   • debounced page search (/v1/search) — selecting a page does a full-page
//     nav to /p/<id> (SSR re-reads the session cookie; established repo lesson),
//   • quick actions: New page, New database, Go to Trash, Toggle dark mode,
//     Toggle language.
//
// New page/database need a workspace; we resolve the user's first workspace
// lazily on open (listWorkspaces auto-provisions one). Arrow/Enter navigate,
// Esc closes.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  createPage,
  dbCreate,
  listWorkspaces,
  search as searchFn,
  type SearchResult,
  type Workspace,
} from '~/server/docs';
import { setThemeCookie, readThemeFromCookie } from '~/lib/theme';

interface QuickAction {
  key: string;
  label: string;
  run: () => void | Promise<void>;
}

function go(href: string) {
  if (typeof window !== 'undefined') window.location.href = href;
}

export function CommandPalette() {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Global open shortcut (⌘K / Ctrl-K).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset + focus + lazily resolve a workspace when opening.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
    setResults([]);
    requestAnimationFrame(() => inputRef.current?.focus());
    if (workspaces.length === 0) {
      void listWorkspaces()
        .then(setWorkspaces)
        .catch(() => setWorkspaces([]));
    }
  }, [open, workspaces.length]);

  // Debounced page search.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = query.trim();
    if (!term) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      void searchFn({ data: { q: term } })
        .then(setResults)
        .catch(() => setResults([]));
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query]);

  const workspaceId = workspaces[0]?.id ?? '';

  const actions = useMemo<QuickAction[]>(() => {
    const other = locale === 'ko' ? 'en' : 'ko';
    return [
      {
        key: 'new-page',
        label: t('cmdK.newPage'),
        run: async () => {
          if (!workspaceId) return;
          const created = await createPage({ data: { workspaceId, title: 'Untitled' } });
          go(`/p/${created.id}`);
        },
      },
      {
        key: 'new-database',
        label: t('cmdK.newDatabase'),
        run: async () => {
          if (!workspaceId) return;
          const created = await dbCreate({ data: { workspaceId, title: 'Untitled database' } });
          go(`/p/${created.id}`);
        },
      },
      {
        key: 'trash',
        label: t('cmdK.goTrash'),
        run: () => go(workspaceId ? `/trash?ws=${workspaceId}` : '/trash'),
      },
      {
        key: 'toggle-theme',
        label: t('cmdK.toggleTheme'),
        run: () => {
          const current = typeof document !== 'undefined' ? readThemeFromCookie(document.cookie) : 'light';
          setThemeCookie(current === 'dark' ? 'light' : 'dark');
          if (typeof window !== 'undefined') window.location.reload();
        },
      },
      {
        key: 'toggle-lang',
        label: t('cmdK.toggleLang'),
        run: () => {
          if (typeof document !== 'undefined') {
            const maxAge = 365 * 24 * 60 * 60;
            document.cookie = `lang=${other}; Path=/; Domain=.allenlabs.org; Max-Age=${maxAge}; SameSite=Lax; Secure`;
            window.location.reload();
          }
        },
      },
    ];
  }, [t, locale, workspaceId]);

  // When a query is present we show matching pages first, then matching
  // actions; with no query, just the actions.
  const filteredActions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query]);

  // Flatten into one indexable list for arrow navigation: pages then actions.
  type Item = { kind: 'page'; page: SearchResult } | { kind: 'action'; action: QuickAction };
  const items = useMemo<Item[]>(
    () => [
      ...results.map((page) => ({ kind: 'page' as const, page })),
      ...filteredActions.map((action) => ({ kind: 'action' as const, action })),
    ],
    [results, filteredActions],
  );

  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, items.length - 1)));
  }, [items.length]);

  function runItem(item: Item | undefined) {
    if (!item) return;
    setOpen(false);
    if (item.kind === 'page') go(`/p/${item.page.id}`);
    else void item.action.run();
  }

  if (!open) return null;

  return (
    <div
      data-testid="quick-find"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white dark:bg-gray-800 shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          data-testid="quick-find-input"
          className="w-full px-4 py-3 text-sm outline-none border-b border-gray-200 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100"
          placeholder={t('cmdK.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, items.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              runItem(items[active]);
            }
          }}
        />
        <ul className="max-h-80 overflow-auto py-1" role="listbox">
          {items.length === 0 ? (
            <li className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400">
              {t('cmdK.noResults')}
            </li>
          ) : (
            items.map((item, idx) => {
              const key = item.kind === 'page' ? `p-${item.page.id}` : `a-${item.action.key}`;
              const label =
                item.kind === 'page'
                  ? `${item.page.icon ?? '📄'} ${item.page.title || t('page.untitled')}`
                  : item.action.label;
              return (
                <li key={key}>
                  <button
                    type="button"
                    data-testid={item.kind === 'action' ? `quick-find-action-${item.action.key}` : undefined}
                    className={`w-full text-left px-4 py-2 text-sm ${
                      idx === active
                        ? 'bg-editor-100 text-editor-800 dark:bg-gray-700 dark:text-gray-100'
                        : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200'
                    }`}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => runItem(item)}
                  >
                    {label}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </div>
    </div>
  );
}
