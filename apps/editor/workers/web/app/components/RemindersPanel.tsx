// Phase 16 — "Remind me" panel. A datetime picker creates a reminder for the
// acting user on this page; existing reminders are listed with a cancel
// action. A cron worker fires due reminders into the notification inbox.

import { useEffect, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  reminderAdd as reminderAddFn,
  reminderCancel as reminderCancelFn,
  remindersList as remindersListFn,
  type ReminderItem,
} from '~/server/docs';

export function RemindersPanel({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const { t } = useT();
  const [items, setItems] = useState<ReminderItem[]>([]);
  const [when, setWhen] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try {
      setItems(await remindersListFn({ data: { pageId } }));
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageId]);

  async function add() {
    if (!when || busy) return;
    setBusy(true);
    try {
      // datetime-local has no timezone — interpret in the browser's locale.
      const iso = new Date(when).toISOString();
      await reminderAddFn({ data: { pageId, remindAt: iso, body: note.trim() || null } });
      setWhen('');
      setNote('');
      await refresh();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
    }
  }

  async function cancel(id: string) {
    try {
      await reminderCancelFn({ data: { id } });
      await refresh();
    } catch {
      /* ignore */
    }
  }

  return (
    <div
      className="absolute right-0 top-9 z-20 w-72 bg-white border border-gray-200 rounded shadow-lg p-3 text-sm dark:bg-gray-800 dark:border-gray-700"
      data-testid="reminders-panel"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-gray-800 dark:text-gray-100">{t('reminder.title')}</span>
        <button
          className="text-gray-400 hover:text-gray-700"
          onClick={onClose}
          aria-label={t('comments.close')}
        >
          ✕
        </button>
      </div>
      <label className="block text-xs text-gray-500 mb-1">{t('reminder.when')}</label>
      <input
        type="datetime-local"
        className="w-full text-xs border border-gray-200 rounded px-2 py-1 mb-2 outline-none focus:border-gray-400 dark:bg-gray-700 dark:border-gray-600"
        value={when}
        onChange={(e) => setWhen(e.target.value)}
        aria-label={t('reminder.when')}
      />
      <input
        type="text"
        className="w-full text-xs border border-gray-200 rounded px-2 py-1 mb-2 outline-none focus:border-gray-400 dark:bg-gray-700 dark:border-gray-600"
        placeholder={t('reminder.notePlaceholder')}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <button
        className="w-full btn-primary text-xs disabled:opacity-50"
        onClick={() => void add()}
        disabled={busy || !when}
      >
        {t('reminder.add')}
      </button>

      {items.length > 0 ? (
        <ul className="mt-3 space-y-1">
          {items.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-xs">
              <span className={`flex-1 truncate ${r.fired ? 'text-gray-400' : 'text-gray-700 dark:text-gray-200'}`}>
                {new Date(r.remindAt).toLocaleString()}
                {r.fired ? ` · ${t('reminder.fired')}` : ''}
              </span>
              <button
                className="text-red-600 hover:text-red-800"
                onClick={() => void cancel(r.id)}
                aria-label={t('reminder.cancel')}
              >
                {t('reminder.cancel')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-xs text-gray-400">{t('reminder.none')}</p>
      )}
    </div>
  );
}
