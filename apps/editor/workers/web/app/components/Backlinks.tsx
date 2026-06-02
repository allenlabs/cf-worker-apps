// Phase 16 — "N linked references" section shown at the bottom of a page.
// Lists pages that link TO this one; each opens via full-page nav (SSR
// re-reads the session cookie — the project's standard nav lesson).

import { useEffect, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { backlinks as backlinksFn, type BacklinkItem } from '~/server/docs';

export function Backlinks({ pageId }: { pageId: string }) {
  const { t } = useT();
  const [items, setItems] = useState<BacklinkItem[]>([]);
  const [open, setOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void backlinksFn({ data: { pageId } })
      .then((list) => {
        if (!cancelled) setItems(list);
      })
      .catch(() => {
        /* ignore — leave empty */
      });
    return () => {
      cancelled = true;
    };
  }, [pageId]);

  if (items.length === 0) return null;

  return (
    <section className="mt-10 border-t border-gray-100 dark:border-gray-800 pt-4" data-testid="backlinks">
      <button
        type="button"
        className="text-xs font-semibold uppercase tracking-wide text-gray-400 hover:text-gray-600 flex items-center gap-1"
        onClick={() => setOpen((v) => !v)}
      >
        <span aria-hidden>{open ? '▾' : '▸'}</span>
        {t('backlinks.heading', { count: String(items.length) })}
      </button>
      {open ? (
        <ul className="mt-2 space-y-1">
          {items.map((b) => (
            <li key={b.id}>
              <a
                href={`/p/${b.id}`}
                className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-200 no-underline hover:underline"
              >
                <span aria-hidden>{b.icon ?? '📄'}</span>
                <span className="truncate">{b.title || t('page.untitled')}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
