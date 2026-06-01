import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import {
  loadHomeImpl,
  type EntrySummary,
  type HomePayload,
} from '~/server/solved';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { bodyPreview, timeAgo } from '~/lib/format';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const loadHome = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  const req = getRequest();
  const cookie = req?.headers.get('cookie') ?? null;
  const token = readSessionToken(cookie);
  if (!token) return null;
  const payload = await verifySessionToken(env, token);
  if (!payload?.sub) return null;
  return loadHomeImpl(getDb(), payload.sub);
});
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => loadHome(),
  component: HomePage,
});

interface EntryCardProps {
  entry: EntrySummary;
  now?: number;
}

export function EntryCardInner({ entry, now }: EntryCardProps) {
  const ago = timeAgo(entry.createdAt, now);
  return (
    <div className="block p-3 text-slate-100" data-testid={`card-${entry.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium truncate">{entry.title}</span>
        <span className="text-xs text-slate-500 shrink-0">{ago}</span>
      </div>
      <p className="mt-1 text-xs text-slate-400 line-clamp-2">
        {bodyPreview(entry.body, 200)}
      </p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
        {entry.source ? (
          <span className="text-solved-300" data-testid={`source-${entry.id}`}>
            {entry.source}
          </span>
        ) : null}
        {entry.tags.map((t) => (
          <span key={t} className="text-slate-400" data-testid={`tag-${entry.id}-${t}`}>
            #{t}
          </span>
        ))}
      </div>
    </div>
  );
}

export function EntryCard({ entry, now }: EntryCardProps) {
  return (
    <li className="card hover:bg-slate-800/40 transition-colors">
      <Link
        to="/entry/$id"
        params={{ id: String(entry.id) }}
        className="block no-underline hover:no-underline"
        data-testid={`link-${entry.id}`}
      >
        <EntryCardInner entry={entry} now={now} />
      </Link>
    </li>
  );
}

export function EmptyState() {
  const { t } = useT();
  return (
    <div className="card p-6 text-center text-sm text-slate-400" data-testid="empty-state">
      <p className="mb-2 text-slate-200">{t('solved.emptyTitle')}</p>
      <p className="text-xs">
        {t('solved.emptyAhaPrefix')}<Link to="/new" className="text-solved-300">{t('solved.emptyAha')}</Link>.
      </p>
    </div>
  );
}

function HomePage() {
  const data = Route.useLoaderData() as HomePayload | null;
  const { t } = useT();

  if (!data) {
    return <div className="p-6 text-slate-400">{t('solved.loading')}</div>;
  }

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        {data.entries.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-2" data-testid="entry-list">
            {data.entries.map((e) => (
              <EntryCard key={e.id} entry={e} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
