// Phase 14: the page header "⋯" overflow menu + its Move-to picker modal.
//
// Items: Duplicate (deep-copy → nav to new root), Move to (page picker →
// reparent), Copy link, Full width (toggle), Lock/Unlock (toggle, owner/
// editor), Export → Markdown / HTML. All page navigation is a full-page load
// so SSR re-reads the session cookie (established repo lesson).

import { useEffect, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  duplicatePage as duplicatePageFn,
  movePage as movePageFn,
  search as searchFn,
  type SearchResult,
} from '~/server/docs';
import { exportPageHtml, exportPageMarkdown } from '~/lib/export';

interface PageMenuProps {
  pageId: string;
  title: string;
  snapshotHtml: string;
  fullWidth: boolean;
  locked: boolean;
  /** owner/editor may lock + change full width; viewers see read-only items only. */
  canEdit: boolean;
  onToggleFullWidth: () => void;
  onToggleLocked: () => void;
}

const PAGE_LINK_BASE = 'https://editor.allenlabs.org/p/';

export function PageMenu({
  pageId,
  title,
  snapshotHtml,
  fullWidth,
  locked,
  canEdit,
  onToggleFullWidth,
  onToggleLocked,
}: PageMenuProps) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setExportOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  async function handleDuplicate() {
    setOpen(false);
    try {
      const created = await duplicatePageFn({ data: { id: pageId } });
      if (typeof window !== 'undefined') window.location.href = `/p/${created.id}`;
    } catch {
      /* ignore */
    }
  }

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(`${PAGE_LINK_BASE}${pageId}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore — clipboard may be unavailable */
    }
  }

  const itemCls =
    'w-full text-left px-3 py-1.5 text-sm rounded hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 disabled:opacity-50';

  return (
    <div className="relative" ref={ref}>
      <button
        className="px-2 py-1 rounded text-sm text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-700"
        onClick={() => setOpen((v) => !v)}
        aria-label={t('page.moreActions')}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="page-menu-button"
      >
        ⋯
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute right-0 top-9 z-30 w-52 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded shadow-lg p-1"
          data-testid="page-menu"
        >
          <button className={itemCls} onClick={() => void handleDuplicate()} role="menuitem">
            {t('pageMenu.duplicate')}
          </button>
          <button
            className={itemCls}
            onClick={() => {
              setOpen(false);
              setMoveOpen(true);
            }}
            role="menuitem"
            disabled={!canEdit}
          >
            {t('pageMenu.moveTo')}
          </button>
          <button className={itemCls} onClick={() => void handleCopyLink()} role="menuitem">
            {copied ? t('share.copied') : t('pageMenu.copyLink')}
          </button>
          <button
            className={itemCls}
            onClick={() => {
              onToggleFullWidth();
              setOpen(false);
            }}
            role="menuitem"
            disabled={!canEdit}
          >
            {fullWidth ? t('pageMenu.fullWidthOff') : t('pageMenu.fullWidth')}
          </button>
          <button
            className={itemCls}
            onClick={() => {
              onToggleLocked();
              setOpen(false);
            }}
            role="menuitem"
            disabled={!canEdit}
            data-testid="page-menu-lock"
          >
            {locked ? t('pageMenu.unlock') : t('pageMenu.lock')}
          </button>
          <div className="my-1 border-t border-gray-100 dark:border-gray-700" />
          <button
            className={itemCls}
            onClick={() => setExportOpen((v) => !v)}
            role="menuitem"
            aria-expanded={exportOpen}
          >
            {t('pageMenu.export')}
          </button>
          {exportOpen ? (
            <div className="pl-2">
              <button
                className={itemCls}
                onClick={() => {
                  exportPageMarkdown(title, snapshotHtml);
                  setOpen(false);
                }}
                role="menuitem"
              >
                {t('pageMenu.exportMarkdown')}
              </button>
              <button
                className={itemCls}
                onClick={() => {
                  exportPageHtml(title, snapshotHtml);
                  setOpen(false);
                }}
                role="menuitem"
              >
                {t('pageMenu.exportHtml')}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {moveOpen ? (
        <MoveToModal pageId={pageId} onClose={() => setMoveOpen(false)} />
      ) : null}
    </div>
  );
}

/** Move-to picker: search workspace pages, pick a new parent (or root). */
function MoveToModal({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { t } = useT();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const term = query.trim();
    if (!term) {
      setResults([]);
      return;
    }
    timer.current = setTimeout(() => {
      void searchFn({ data: { q: term } })
        .then((r) => setResults(r.filter((p) => p.id !== pageId)))
        .catch(() => setResults([]));
    }, 200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [query, pageId]);

  async function move(parentId: string | null) {
    if (busy) return;
    setBusy(true);
    try {
      await movePageFn({ data: { id: pageId, parentId } });
      if (typeof window !== 'undefined') window.location.href = `/p/${pageId}`;
    } catch {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={onClose}
      data-testid="move-to-modal"
    >
      <div
        className="w-full max-w-md rounded-lg bg-white dark:bg-gray-800 shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          className="w-full px-4 py-3 text-sm outline-none border-b border-gray-200 dark:border-gray-700 bg-transparent text-gray-900 dark:text-gray-100"
          placeholder={t('pageMenu.movePlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t('pageMenu.moveTo')}
        />
        <ul className="max-h-80 overflow-auto py-1">
          <li>
            <button
              className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 disabled:opacity-50"
              onClick={() => void move(null)}
              disabled={busy}
            >
              {t('pageMenu.moveToRoot')}
            </button>
          </li>
          {results.map((r) => (
            <li key={r.id}>
              <button
                className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200 disabled:opacity-50 flex items-center gap-1"
                onClick={() => void move(r.id)}
                disabled={busy}
              >
                <span className="shrink-0">{r.icon ?? '📄'}</span>
                <span className="truncate">{r.title || t('page.untitled')}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
