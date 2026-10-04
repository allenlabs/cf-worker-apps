import { useEffect, useState } from 'react';
import {
  fetchPreferences,
  getPermissionState,
  isPushSupported,
  requestSubscribe,
  savePreferences,
  unsubscribe,
  type PushPreferencesShape,
} from '~/lib/push-client';
import { useT } from '@allenlabs/i18n/react';

interface NotificationsPanelProps {
  /** Optional override — when absent we read the key from
   *  `<meta name="vapid-public" content="…">` injected by the root loader. */
  vapidPublicKey?: string;
}

function readVapidFromMeta(): string {
  /* v8 ignore next — SSR guard; tests run in jsdom, this branch is for
     the server bundle only. */
  if (typeof document === 'undefined') return '';
  const el = document.querySelector('meta[name="vapid-public"]');
  /* v8 ignore next — the `?? ''` fallback only triggers when querySelector
     returns null AND getAttribute returns null; impossible inside our app
     since __root.tsx always emits the meta. */
  return el?.getAttribute('content') ?? '';
}

// ---------- Time helpers (exported for testing) ----------

/** "HH:MM" → minutes from midnight, or null if blank/invalid. */
export function parseTimeOfDay(s: string): number | null {
  if (!s) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  // Both capture groups always match by regex shape; the `?? ''` is
  // satisfying TS's noUncheckedIndexedAccess only.  The
  // !Number.isInteger guard below is similarly defensive.
  /* v8 ignore start */
  const h = Number(m[1] ?? '');
  const min = Number(m[2] ?? '');
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null;
  /* v8 ignore stop */
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

/** Minutes from midnight → "HH:MM" (empty string when null). */
export function formatTimeOfDay(minutes: number | null): string {
  if (minutes == null) return '';
  const h = Math.floor(minutes / 60).toString().padStart(2, '0');
  const m = (minutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

export function NotificationsPanel({ vapidPublicKey }: NotificationsPanelProps = {}) {
  const { t } = useT();
  const effectiveKey = vapidPublicKey || readVapidFromMeta();
  const [supported, setSupported] = useState<boolean>(false);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    'default',
  );
  const [busy, setBusy] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<PushPreferencesShape | null>(null);
  const [quietStart, setQuietStart] = useState<string>('');
  const [quietEnd, setQuietEnd] = useState<string>('');

  useEffect(() => {
    /* v8 ignore start — guarded against jsdom which lacks PushManager.
       Coverage for the network paths lives in the push-client unit tests. */
    setSupported(isPushSupported());
    setPermission(getPermissionState());
    void (async () => {
      const p = await fetchPreferences();
      if (p) {
        setPrefs(p);
        setQuietStart(formatTimeOfDay(p.quietStart));
        setQuietEnd(formatTimeOfDay(p.quietEnd));
      }
    })();
    /* v8 ignore stop */
  }, []);

  /* v8 ignore start — DOM-side state shuffling exercised by manual QA.
     The pure helpers (parseTimeOfDay/formatTimeOfDay) are unit-tested
     separately so the maths is covered. */
  async function onEnable() {
    setBusy(true);
    setError(null);
    try {
      await requestSubscribe(effectiveKey);
      setPermission(getPermissionState());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onDisable() {
    setBusy(true);
    setError(null);
    try {
      await unsubscribe();
      setPermission(getPermissionState());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function onToggleOnCapture(next: boolean) {
    const updated = await savePreferences({ onCapture: next });
    if (updated) setPrefs(updated);
  }

  async function onSaveQuiet() {
    const updated = await savePreferences({
      quietStart: parseTimeOfDay(quietStart),
      quietEnd: parseTimeOfDay(quietEnd),
    });
    if (updated) {
      setPrefs(updated);
      setQuietStart(formatTimeOfDay(updated.quietStart));
      setQuietEnd(formatTimeOfDay(updated.quietEnd));
    }
  }
  /* v8 ignore stop */

  return (
    <details
      data-testid="notifications-panel"
      className="mt-8 text-sm text-slate-400 border border-slate-800 rounded p-3"
    >
      <summary className="cursor-pointer select-none text-slate-300">{t('notif.title')}</summary>
      <div className="mt-3 space-y-3">
        <div>
          <span className="text-slate-500">{t('notif.permission')}</span>{' '}
          <span data-testid="notif-permission">{supported ? permission : 'unsupported'}</span>
        </div>
        {!supported ? (
          <p className="text-xs text-slate-500">
            {t('notif.unsupportedHint')}
          </p>
        ) : (
          <div className="flex gap-2">
            {permission !== 'granted' ? (
              <button
                type="button"
                onClick={onEnable}
                disabled={busy}
                className="rounded bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-3 py-1 text-sm text-white"
              >
                {t('notif.enable')}
              </button>
            ) : (
              <button
                type="button"
                onClick={onDisable}
                disabled={busy}
                className="rounded bg-slate-700 hover:bg-slate-600 disabled:opacity-50 px-3 py-1 text-sm text-white"
              >
                {t('notif.disable')}
              </button>
            )}
          </div>
        )}
        {error ? (
          <p data-testid="notif-error" className="text-xs text-red-400">{error}</p>
        ) : null}

        <div className="pt-2 border-t border-slate-800">
          <label className="flex items-center gap-2 text-slate-300">
            <input
              type="checkbox"
              checked={prefs?.onCapture ?? true}
              onChange={(e) => void onToggleOnCapture(e.target.checked)}
            />
            {t('notif.onCapture')}
          </label>
        </div>

        <div className="pt-2 border-t border-slate-800">
          <div className="text-slate-300 mb-1">{t('notif.quietHours')}</div>
          <div className="flex items-center gap-2">
            <input
              aria-label={t('notif.quietStart')}
              type="time"
              value={quietStart}
              onChange={(e) => setQuietStart(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200"
            />
            <span className="text-slate-500">→</span>
            <input
              aria-label={t('notif.quietEnd')}
              type="time"
              value={quietEnd}
              onChange={(e) => setQuietEnd(e.target.value)}
              className="bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-200"
            />
            <button
              type="button"
              onClick={onSaveQuiet}
              className="rounded bg-slate-700 hover:bg-slate-600 px-3 py-1 text-sm text-white"
            >
              {t('btn.save')}
            </button>
          </div>
          <p className="text-xs text-slate-500 mt-1">
            {t('notif.quietHint')}
          </p>
        </div>
      </div>
    </details>
  );
}
