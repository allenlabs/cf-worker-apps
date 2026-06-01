import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import {
  loadHomeImpl,
  type HomePayload,
} from '~/server/context';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { restoreCountLabel, timeAgo } from '~/lib/format';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
// Server function: home payload.  Verifies the JWT, then dispatches to
// loadHomeImpl which does the rest in one Hetzner round-trip.
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
  loader: async () => {
    const data = await loadHome();
    return data;
  },
  component: HomePage,
});

// ---------- presentational pieces (exported for tests) ----------

interface SnapshotRowInnerProps {
  snapshot: HomePayload['snapshots'][number];
  now?: number;
}

/**
 * Pure presentational row (no Link).  The home page wraps this in a
 * <Link> so the surface is keyboard-navigable; tests use the inner one
 * directly to keep the router context out of the unit harness.
 */
export function SnapshotRowInner({ snapshot, now }: SnapshotRowInnerProps) {
  const ago = timeAgo(snapshot.createdAt, now);
  return (
    <div className="block p-3 text-slate-100" data-testid={`row-${snapshot.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium truncate">{snapshot.name}</span>
        <span className="text-xs text-slate-500 shrink-0">{ago}</span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-slate-400">
        <span>{restoreCountLabel(snapshot.restoredCount)}</span>
        {snapshot.hasCwd ? <span className="text-ctx-300">cwd</span> : null}
        {snapshot.hasBranch ? <span className="text-ctx-300">branch</span> : null}
      </div>
    </div>
  );
}

export function SnapshotRow({ snapshot, now }: SnapshotRowInnerProps) {
  return (
    <li className="card hover:bg-slate-800/40 transition-colors">
      <Link
        to="/$id"
        params={{ id: String(snapshot.id) }}
        className="block no-underline"
        data-testid={`link-${snapshot.id}`}
      >
        <SnapshotRowInner snapshot={snapshot} now={now} />
      </Link>
    </li>
  );
}

export function EmptyState() {
  const { t } = useT();
  return (
    <div className="card p-6 text-center text-sm text-slate-400" data-testid="empty-state">
      <p className="mb-2 text-slate-200">{t('context.noSnapshots')}</p>
      <p className="text-xs">
        {t('context.cliHintPrefix')} <code className="text-ctx-300">al ctx save "fixing auth bug"</code>
      </p>
    </div>
  );
}

// ---------- page component ----------

function HomePage() {
  const data = Route.useLoaderData();
  const { t } = useT();

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-lg font-semibold text-slate-200 mb-1">{t('context.title')}</h1>
      <p className="text-xs text-slate-500 mb-6">
        {t('context.subtitleHome')}
      </p>
      {data.snapshots.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="space-y-2" data-testid="snapshot-list">
          {data.snapshots.map((s) => (
            <SnapshotRow key={s.id} snapshot={s} />
          ))}
        </ul>
      )}
    </div>
  );
}
