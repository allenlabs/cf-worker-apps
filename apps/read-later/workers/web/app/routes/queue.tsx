import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  listItemsImpl,
  type ItemSummary,
  type ListPayload,
} from '~/server/read-later';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { getRequest } from '@tanstack/react-start/server';
import { useT } from '@allenlabs/i18n/react';
import { readingTimeLabel, timeAgo } from '~/lib/format';

const SearchSchema = z.object({
  tag: z.string().optional(),
  all: z.coerce.boolean().optional(),
});

const ListInput = z.object({
  tag: z.string().optional(),
  all: z.boolean().optional(),
});

/* v8 ignore start */
const loadList = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => ListInput.parse(data))
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
    return listItemsImpl(db, me.id, {
      tag: data.tag,
      includeRead: data.all === true,
    });
  });
/* v8 ignore stop */

export const Route = createFileRoute('/queue')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({ tag: search.tag, all: search.all }),
  loader: async ({ deps }) => {
    return loadList({ data: { tag: deps.tag, all: deps.all } });
  },
  component: QueueListPage,
});

// ---------- presentational pieces (exported for tests) ----------

interface QueueListRowProps {
  item: ItemSummary;
  now?: number;
}

export function QueueListRow({ item, now }: QueueListRowProps) {
  const { t } = useT();
  const timeLabel = readingTimeLabel(item.estimatedMinutes);
  const read = item.readAt != null;
  return (
    <li className={`card hover:bg-slate-800/40 transition-colors ${read ? 'opacity-60' : ''}`}>
      <Link
        to="/saved/$id"
        params={{ id: String(item.id) }}
        className="block p-3 no-underline"
        data-testid={`row-${item.id}`}
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium truncate text-slate-100">
            {item.title ?? item.url}
          </span>
          <span className="text-xs text-slate-500 shrink-0">
            {timeAgo(item.savedAt, now)}
          </span>
        </div>
        <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
          <span className="text-slate-500">{item.hostname}</span>
          {timeLabel ? <span>{timeLabel}</span> : null}
          {read ? <span className="text-rl-300">{t('rl.done')}</span> : null}
          {item.tags.map((t) => (
            <span key={t} className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">
              #{t}
            </span>
          ))}
        </div>
      </Link>
    </li>
  );
}

export function QueueListEmpty({ filtering }: { filtering: boolean }) {
  const { t } = useT();
  return (
    <div className="card p-6 text-center text-sm text-slate-400" data-testid="list-empty">
      <p className="mb-2 text-slate-200">
        {filtering ? t('rl.noItemsMatch') : t('rl.noItems')}
      </p>
      {filtering ? (
        <Link to="/queue" className="text-rl-400 hover:underline">{t('rl.clearFilter')}</Link>
      ) : (
        <p className="text-xs">
          {t('rl.saveHint')} <code className="text-rl-300">al rl save &lt;url&gt;</code>
        </p>
      )}
    </div>
  );
}

// ---------- page component ----------

function QueueListPage() {
  const data = Route.useLoaderData() as ListPayload | null;
  const search = Route.useSearch();
  const { t } = useT();

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  const filtering = Boolean(search.tag) || search.all === true;

  return (
    <div className="max-w-2xl mx-auto p-6">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-slate-200">
          {t('rl.queue')}
          <span className="ml-2 text-xs text-slate-500">{t('rl.totalCount', { n: data.total })}</span>
        </h1>
        <nav className="flex gap-3 text-xs">
          <Link to="/" className="text-rl-400 hover:underline">{t('rl.nextUp')}</Link>
          <Link
            to="/queue"
            search={{ all: !(search.all === true) }}
            className="text-slate-500 hover:underline"
            data-testid="toggle-all"
          >
            {search.all === true ? t('rl.hideRead') : t('rl.showRead')}
          </Link>
        </nav>
      </div>
      {search.tag ? (
        <p className="mb-3 text-xs text-slate-500">
          {t('rl.filteredByTag')} <code className="text-rl-300">#{search.tag}</code>{' '}
          <Link to="/queue" className="ml-1 text-rl-400 hover:underline">{t('rl.clear')}</Link>
        </p>
      ) : null}
      {data.items.length === 0 ? (
        <QueueListEmpty filtering={filtering} />
      ) : (
        <ul className="space-y-2" data-testid="list">
          {data.items.map((i) => (
            <QueueListRow key={i.id} item={i} />
          ))}
        </ul>
      )}
    </div>
  );
}
