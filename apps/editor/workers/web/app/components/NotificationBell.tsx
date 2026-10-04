// Phase 16 — notification inbox bell for the header. Shows an unread badge and
// a dropdown inbox. Polls the unread count on an interval (no websockets);
// opening the panel loads the list and marks everything read.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  notificationsList as notificationsListFn,
  notificationsMarkRead as markReadFn,
  notificationsUnreadCount as unreadCountFn,
  type NotificationItem,
} from '~/server/docs';

const POLL_MS = 60_000;

/** Phrase a notification by kind + actor + page title. */
function describe(t: (k: string, p?: Record<string, string>) => string, n: NotificationItem): string {
  const who = n.actor ?? t('inbox.someone');
  switch (n.kind) {
    case 'mention':
      return t('inbox.mentioned', { who });
    case 'comment':
      return t('inbox.commented', { who });
    case 'reaction':
      return t('inbox.reacted', { who });
    case 'reminder':
      return t('inbox.reminder');
    /* v8 ignore next 2 — kind is a closed union; default is defensive only. */
    default:
      return who;
  }
}

export function NotificationBell() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [count, setCount] = useState(0);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const ref = useRef<HTMLDivElement>(null);

  const loadCount = useCallback(async () => {
    try {
      const { count: c } = await unreadCountFn();
      setCount(c);
    } catch {
      /* ignore — keep last good value */
    }
  }, []);

  // Poll the unread count.
  useEffect(() => {
    void loadCount();
    const id = setInterval(() => void loadCount(), POLL_MS);
    return () => clearInterval(id);
  }, [loadCount]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next) {
      try {
        const list = await notificationsListFn({ data: {} });
        setItems(list);
        // Mark all read on open, then refresh the badge.
        if (list.some((n) => !n.read)) {
          await markReadFn({ data: { all: true } });
          setCount(0);
        }
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="relative text-white/90 hover:text-white"
        onClick={() => void toggle()}
        aria-label={t('inbox.title')}
        data-testid="notification-bell"
      >
        <span aria-hidden>🔔</span>
        {count > 0 ? (
          <span
            className="absolute -top-1 -right-2 min-w-4 h-4 px-1 rounded-full bg-red-500 text-white text-[10px] leading-4 text-center"
            data-testid="notification-badge"
          >
            {count > 99 ? '99+' : count}
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          className="absolute right-0 mt-2 w-80 max-h-96 overflow-y-auto rounded-lg border border-gray-200 bg-white text-gray-900 shadow-lg z-50 dark:bg-gray-800 dark:border-gray-700 dark:text-gray-100"
          data-testid="notification-panel"
        >
          <div className="px-3 py-2 border-b border-gray-100 dark:border-gray-700 text-sm font-semibold">
            {t('inbox.title')}
          </div>
          {items.length === 0 ? (
            <p className="px-3 py-4 text-xs text-gray-400">{t('inbox.empty')}</p>
          ) : (
            <ul className="divide-y divide-gray-100 dark:divide-gray-700">
              {items.map((n) => {
                const href = n.pageId ? `/p/${n.pageId}` : null;
                const inner = (
                  <>
                    <span className="block text-gray-800 dark:text-gray-100">{describe(t, n)}</span>
                    {n.pageTitle ? (
                      <span className="block text-xs text-gray-500 truncate">{n.pageTitle}</span>
                    ) : null}
                    <span className="block text-[10px] text-gray-400">
                      {new Date(n.createdAt).toLocaleString()}
                    </span>
                  </>
                );
                return (
                  <li key={n.id} className={n.read ? 'opacity-70' : ''}>
                    {href ? (
                      // Full-page nav so the page loads fresh (project convention).
                      <a href={href} className="block px-3 py-2 text-sm no-underline hover:bg-gray-50 dark:hover:bg-gray-700">
                        {inner}
                      </a>
                    ) : (
                      <div className="px-3 py-2 text-sm">{inner}</div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
