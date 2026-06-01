import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { useEffect, useMemo, useState } from 'react';
import { z } from 'zod';
import { TRIAGE_ACTIONS, applyTriageImpl, captureImpl, captureSchema, loadTriageImpl, type TriageAction, type TriagePayload } from '~/server/inbox';
import {
  makeVapidTransport,
  sendCaptureNotificationImpl,
} from '~/server/push';
import { getDb, getEnv, requireUser } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { timeAgo, untilNow } from '~/lib/format';
import { NotificationsPanel } from '~/components/NotificationsPanel';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
// Server function: triage list payload.  Verifies the JWT, then dispatches
// to loadTriageImpl which does the rest in one Hetzner round-trip.
const loadTriage = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  const req = getRequest();
  const cookie = req?.headers.get('cookie') ?? null;
  const token = readSessionToken(cookie);
  if (!token) return null;
  const payload = await verifySessionToken(env, token);
  if (!payload?.sub) return null;
  return loadTriageImpl(getDb(), payload.sub);
});

// Server function: capture from the web UI.  Same impl the API worker uses,
// just behind SSO cookie instead of HMAC.
const captureFromWeb = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => captureSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    const env = getEnv();
    const db = getDb(env);
    const created = await captureImpl(db, me.id, { ...data, source: data.source ?? 'web' });
    // Fire push fan-out (don't block the UI).  Caught so transport errors
    // can't bubble up to the captureFromWeb response.
    if (env.VAPID_PRIVATE_KEY) {
      void sendCaptureNotificationImpl(
        env,
        db,
        me.id,
        { id: created.id, text: data.text },
        { transport: makeVapidTransport(env) },
      ).catch((err) => {
        console.error('[push] sendCaptureNotificationImpl failed', err);
      });
    }
    return created;
  });

const ActionInput = z.object({ id: z.number().int().positive(), action: z.enum(TRIAGE_ACTIONS) });
const triageItem = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => ActionInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return applyTriageImpl(getDb(), me.id, data);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => {
    const data = await loadTriage();
    return data;
  },
  component: TriagePage,
});

// ---------- helpers exported for tests ----------

export const KEY_TO_ACTION: Record<string, TriageAction> = {
  '1': 'pin',
  '2': 'refile_pm_placeholder',
  d: 'drop',
  D: 'drop',
  s: 'snooze1d',
  S: 'snooze1w',
  u: 'unread',
};

export function nextIndex(current: number, len: number, delta: number): number {
  if (len === 0) return 0;
  return Math.max(0, Math.min(len - 1, current + delta));
}

interface CaptureBoxProps {
  onCapture: (text: string) => void;
}

export function CaptureBox({ onCapture }: CaptureBoxProps) {
  const [text, setText] = useState('');
  const { t } = useT();
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (!t) return;
        onCapture(t);
        setText('');
      }}
      className="flex gap-2 mb-6"
    >
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('inbox.placeholder')}
        aria-label={t('inbox.capture')}
        className="flex-1 rounded bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
      />
      <button
        type="submit"
        className="rounded bg-emerald-600 hover:bg-emerald-500 px-4 py-2 text-sm font-medium text-white"
      >
        {t('inbox.capture')}
      </button>
    </form>
  );
}

interface ItemRowProps {
  item: TriagePayload['unread'][number];
  selected: boolean;
}

export function ItemRow({ item, selected }: ItemRowProps) {
  const { t } = useT();
  return (
    <li
      data-testid={`item-${item.id}`}
      data-selected={selected ? 'true' : 'false'}
      className={`rounded border px-3 py-2 mb-1 transition-colors ${
        selected
          ? 'border-emerald-500 bg-slate-800'
          : 'border-slate-800 bg-slate-900 hover:bg-slate-800/60'
      }`}
    >
      <div className="text-sm">{item.text}</div>
      <div className="mt-1 text-xs text-slate-500 flex flex-wrap gap-2">
        <span>{timeAgo(item.capturedAt)}</span>
        {item.source ? <span>· {t('inbox.via', { source: item.source })}</span> : null}
        {item.snoozedUntil ? <span>· {t('inbox.wakes', { when: untilNow(item.snoozedUntil) })}</span> : null}
        {item.tags?.length ? <span>· #{item.tags.join(' #')}</span> : null}
      </div>
    </li>
  );
}

export function EmptyState() {
  const { t } = useT();
  return (
    <div
      data-testid="inbox-zero"
      className="text-center py-16 px-6 rounded-lg border border-emerald-700/40 bg-emerald-950/30"
    >
      <div className="text-5xl mb-3">▣</div>
      <h2 className="text-xl font-semibold text-emerald-200 mb-1">{t('inbox.zero')}</h2>
      <p className="text-sm text-emerald-300/80">
        {t('inbox.zeroHint')}
      </p>
    </div>
  );
}

function TriagePage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const items = useMemo(() => {
    if (!data) return [];
    // Pinned first, then unread, then snoozed/done in a folded section.
    // The "active triage list" — what j/k navigates — is pinned + unread.
    return [...data.pinned, ...data.unread];
  }, [data]);

  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't hijack keys while typing into an input.
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;

      if (e.key === 'j') {
        e.preventDefault();
        setCursor((c) => nextIndex(c, items.length, +1));
        return;
      }
      if (e.key === 'k') {
        e.preventDefault();
        setCursor((c) => nextIndex(c, items.length, -1));
        return;
      }
      const action = KEY_TO_ACTION[e.key];
      if (!action) return;
      const current = items[cursor];
      if (!current) return;
      e.preventDefault();
      // Fire-and-await but don't block — UI feels snappier when we
      // optimistically advance the cursor; the loader re-runs on response.
      /* v8 ignore next 4 */
      void triageItem({ data: { id: current.id, action } }).then(() => {
        router.invalidate();
      });
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cursor, items, router]);

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-lg font-semibold mb-4 text-slate-200">{t('inbox.title')}</h1>
      <CaptureBox
        onCapture={(text) => {
          /* v8 ignore next 3 */
          void captureFromWeb({ data: { text, source: 'web' } }).then(() => router.invalidate());
        }}
      />
      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <ul aria-label={t('inbox.triageLabel')}>
          {items.map((it, idx) => (
            <ItemRow key={it.id} item={it} selected={idx === cursor} />
          ))}
        </ul>
      )}
      {data.snoozed.length > 0 ? (
        <details className="mt-8 text-sm text-slate-400">
          <summary>{t('inbox.snoozed', { n: data.snoozed.length })}</summary>
          <ul className="mt-2">
            {data.snoozed.map((it) => (
              <ItemRow key={it.id} item={it} selected={false} />
            ))}
          </ul>
        </details>
      ) : null}
      <NotificationsPanel />
      <div className="mt-8 text-xs text-slate-500">
        {t('inbox.keysHint')}
      </div>
    </div>
  );
}
