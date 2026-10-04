import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  deleteItemImpl,
  getItemImpl,
  markDoneImpl,
  type ItemDetail,
} from '~/server/read-later';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv, requireUser } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { getRequest } from '@tanstack/react-start/server';
import { useT } from '@allenlabs/i18n/react';
import { hostnameOf, readingTimeLabel, timeAgo } from '~/lib/format';

const IdInput = z.object({ id: z.number().int().positive() });

/* v8 ignore start */
const loadItem = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const env = getEnv();
    const cookie = getRequest()?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    if (!token) return null;
    const payload = await verifySessionToken(env, token);
    if (!payload?.sub) return null;
    const db = getDb();
    const me = await findUserBySsoImpl(db, payload.sub);
    if (!me) return null;
    return getItemImpl(db, me.id, data.id);
  });

const markDone = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return markDoneImpl(getDb(), me.id, data.id);
  });

const deleteItem = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return deleteItemImpl(getDb(), me.id, data.id);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/saved/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    return loadItem({ data: { id } });
  },
  component: SavedDetailPage,
});

// ---------- presentational pieces (exported for tests) ----------

interface ReaderHeaderProps {
  item: ItemDetail;
  now?: number;
}

export function ReaderHeader({ item, now }: ReaderHeaderProps) {
  const { t } = useT();
  const host = hostnameOf(item.url) || item.url;
  const timeLabel = readingTimeLabel(item.estimatedMinutes);
  return (
    <header className="mb-6 border-b border-slate-800 pb-4" data-testid="reader-header">
      <div className="flex flex-wrap items-baseline gap-3 text-xs text-slate-500">
        <a href={item.url} target="_blank" rel="noopener noreferrer" className="text-rl-400 hover:underline">
          {host} ↗
        </a>
        <span>{t('rl.savedPrefix')} {timeAgo(item.savedAt, now)}</span>
        {timeLabel ? <span data-testid="reader-time">{timeLabel}</span> : null}
        {item.readAt ? <span className="text-rl-300">{t('rl.done')}</span> : null}
      </div>
      <h1 className="mt-2 text-2xl font-semibold text-slate-50">
        {item.title ?? item.url}
      </h1>
      {item.excerpt && !item.contentHtml ? (
        <p className="mt-3 text-sm text-slate-300">{item.excerpt}</p>
      ) : null}
    </header>
  );
}

interface ReaderBodyProps {
  item: ItemDetail;
}

export function ReaderBody({ item }: ReaderBodyProps) {
  const { t } = useT();
  if (item.contentHtml) {
    return (
      <article
        className="reader-mode"
        data-testid="reader-body"
        dangerouslySetInnerHTML={{ __html: item.contentHtml }}
      />
    );
  }
  // No extracted body — show a fallback with a link.
  return (
    <div className="mt-6 card p-6 text-sm text-slate-300" data-testid="reader-fallback">
      <p className="mb-3">
        {t('rl.extractFail')}
      </p>
      <a
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        className="rounded bg-rl-600 hover:bg-rl-500 px-4 py-2 text-white inline-block"
      >
        {t('rl.openOriginalArrow')}
      </a>
    </div>
  );
}

// ---------- page component ----------

function SavedDetailPage() {
  const initial = Route.useLoaderData() as ItemDetail | null;
  const router = useRouter();
  const { t } = useT();

  if (!initial) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-slate-400" data-testid="not-found">
        <p>{t('rl.itemNotFound')}</p>
        <Link to="/queue" className="text-rl-400 hover:underline">{t('rl.backToQueue')}</Link>
      </div>
    );
  }

  return (
    <div>
      <div className="max-w-2xl mx-auto pt-6 px-6">
        <Link to="/queue" className="text-xs text-rl-400 hover:underline">{t('rl.backToQueue')}</Link>
        <ReaderHeader item={initial} />
        <ReaderBody item={initial} />
        <div className="mt-8 flex flex-wrap gap-3 text-sm">
          {!initial.readAt ? (
            <button
              type="button"
              className="rounded bg-rl-600 hover:bg-rl-500 px-4 py-2 font-semibold text-white"
              data-testid="mark-done"
              onClick={() => {
                /* v8 ignore next 5 — deploy smoke covers the round-trip. */
                void markDone({ data: { id: initial.id } }).then(() => {
                  router.invalidate();
                });
              }}
            >
              {t('rl.markDone')}
            </button>
          ) : null}
          <button
            type="button"
            className="rounded border border-slate-800 px-4 py-2 text-xs text-slate-400 hover:bg-slate-800"
            data-testid="delete"
            onClick={() => {
              /* v8 ignore next 7 — deploy smoke covers the delete. */
              if (!confirm(t('rl.deleteConfirm'))) return;
              void deleteItem({ data: { id: initial.id } }).then(() => {
                router.navigate({ to: '/queue' });
              });
            }}
          >
            {t('btn.delete')}
          </button>
        </div>
      </div>
    </div>
  );
}
