import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  loadQueueImpl,
  markDoneImpl,
  skipItemImpl,
  type QueuePayload,
  type ItemSummary,
} from '~/server/read-later';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv, requireUser } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { readingTimeLabel, skipCountLabel, timeAgo } from '~/lib/format';

const IdInput = z.object({ id: z.number().int().positive() });

/* v8 ignore start */
const loadQueue = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  const req = getRequest();
  const cookie = req?.headers.get('cookie') ?? null;
  const token = readSessionToken(cookie);
  if (!token) return null;
  const payload = await verifySessionToken(env, token);
  if (!payload?.sub) return null;
  return loadQueueImpl(getDb(), payload.sub);
});

const markDone = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return markDoneImpl(getDb(), me.id, data.id);
  });

const skipItem = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return skipItemImpl(getDb(), me.id, data.id);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => {
    const data = await loadQueue();
    return data;
  },
  component: QueuePage,
});

// ---------- presentational pieces (exported for tests) ----------

interface QueueCardProps {
  item: ItemSummary;
  now?: number;
  onDone: () => void;
  onSkip: () => void;
  busy?: boolean;
}

/**
 * The ONE-thing-to-read card.  ADHD-friendly: a single primary action
 * (Read now), a single secondary action (Skip for now), and a tiny tertiary
 * (Done — already read it elsewhere).
 */
export function QueueCard({ item, now, onDone, onSkip, busy }: QueueCardProps) {
  const { t } = useT();
  const timeLabel = readingTimeLabel(item.estimatedMinutes);
  const skipped = skipCountLabel(item.skippedCount);
  return (
    <div className="card p-6" data-testid={`queue-card-${item.id}`}>
      <div className="flex items-baseline justify-between gap-3 text-xs text-slate-500">
        <span>{item.hostname || t('rl.linkFallback')}</span>
        <span>{t('rl.savedPrefix')} {timeAgo(item.savedAt, now)}</span>
      </div>
      <h2 className="mt-2 text-xl font-semibold text-slate-100">
        {item.title ?? item.url}
      </h2>
      {item.excerpt ? (
        <p className="mt-2 text-sm text-slate-300 line-clamp-3">{item.excerpt}</p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
        {timeLabel ? <span data-testid="time-label">{timeLabel}</span> : null}
        {skipped ? <span className="text-rl-300">{skipped}</span> : null}
        {item.tags.map((t) => (
          <span key={t} className="rounded bg-slate-800 px-2 py-0.5 text-slate-300">
            #{t}
          </span>
        ))}
      </div>
      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Link
          to="/saved/$id"
          params={{ id: String(item.id) }}
          className="rounded bg-rl-600 hover:bg-rl-500 px-4 py-2 text-center font-semibold text-white"
          data-testid="read-now"
        >
          {t('rl.readNow')}
        </Link>
        <button
          type="button"
          onClick={onSkip}
          disabled={busy}
          className="rounded border border-slate-700 px-4 py-2 text-slate-200 hover:bg-slate-800 disabled:opacity-50"
          data-testid="skip"
        >
          {t('rl.skipForNow')}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={busy}
          className="rounded border border-slate-800 px-4 py-2 text-xs text-slate-400 hover:bg-slate-800 disabled:opacity-50"
          data-testid="done"
        >
          {t('rl.doneAlready')}
        </button>
      </div>
    </div>
  );
}

export function QueueEmpty({ unreadCount }: { unreadCount: number }) {
  const { t } = useT();
  return (
    <div className="card p-6 text-center text-slate-300" data-testid="queue-empty">
      <p className="text-lg font-semibold mb-1">{t('rl.nothingToRead')}</p>
      <p className="text-xs text-slate-500 mb-3">
        {unreadCount === 0
          ? t('rl.queueEmptyHint')
          : t(unreadCount === 1 ? 'rl.noneSurfaceOne' : 'rl.noneSurfaceMany', { n: unreadCount })}
      </p>
      <Link to="/queue" className="text-rl-400 hover:underline text-sm">
        {t('rl.viewFullQueue')}
      </Link>
    </div>
  );
}

export function QueueHeader({ unreadCount }: { unreadCount: number }) {
  const { t } = useT();
  return (
    <div className="mb-4 flex items-center justify-between" data-testid="queue-header">
      <div>
        <h1 className="text-lg font-semibold text-slate-200">{t('rl.title')}</h1>
        <p className="text-xs text-slate-500">
          {unreadCount === 0
            ? t('rl.inboxZero')
            : t('rl.unreadCount', { n: unreadCount })}
        </p>
      </div>
      <nav className="flex gap-3 text-xs">
        <Link to="/queue" className="text-rl-400 hover:underline">{t('rl.fullQueue')}</Link>
        <Link to="/admin/api-clients" className="text-slate-500 hover:underline">{t('rl.tokens')}</Link>
      </nav>
    </div>
  );
}

// ---------- page component ----------

function QueuePage() {
  const data = Route.useLoaderData() as QueuePayload | null;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const { t } = useT();

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <QueueHeader unreadCount={data.unreadCount} />
      {data.next ? (
        <QueueCard
          item={data.next}
          busy={busy}
          onSkip={() => {
            /* v8 ignore next 6 — deploy smoke covers the round-trip. */
            if (!data.next) return;
            setBusy(true);
            void skipItem({ data: { id: data.next.id } }).finally(() => {
              setBusy(false);
              router.invalidate();
            });
          }}
          onDone={() => {
            /* v8 ignore next 6 — deploy smoke covers the round-trip. */
            if (!data.next) return;
            setBusy(true);
            void markDone({ data: { id: data.next.id } }).finally(() => {
              setBusy(false);
              router.invalidate();
            });
          }}
        />
      ) : (
        <QueueEmpty unreadCount={data.unreadCount} />
      )}
    </div>
  );
}
