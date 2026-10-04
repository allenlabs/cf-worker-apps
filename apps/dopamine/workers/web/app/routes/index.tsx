import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import {
  getRandomWinImpl,
  loadHomeImpl,
  type EventRow,
  type HomePayload,
} from '~/server/dopamine';
import { getDb, requireUser, getEnv } from '~/server/auth-runtime.server';
import { getRequest } from '@tanstack/react-start/server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { Header } from '~/components/Header';
import { EventCard } from '~/components/EventCard';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const loadHome = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  let req: Request | undefined;
  try { req = getRequest(); } catch { return null; }
  const cookie = req?.headers.get('cookie') ?? null;
  const token = readSessionToken(cookie);
  if (!token) return null;
  const payload = await verifySessionToken(env, token);
  if (!payload?.sub) return null;
  return loadHomeImpl(getDb(), payload.sub);
});

const fetchRandom = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) =>
    z.object({ sinceDays: z.number().int().min(1).max(3650).default(90) }).parse(data),
  )
  .handler(async ({ data }) => {
    const me = await requireUser();
    return getRandomWinImpl(getDb(), me.id, data.sinceDays);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => loadHome(),
  component: HomePage,
});

export function EmptyFeed() {
  const { t } = useT();
  return (
    <div className="card p-4 text-sm text-slate-400" data-testid="empty-feed">
      {t('dopamine.emptyFeed')}
    </div>
  );
}

export function RandomWinPanel({
  highlight,
  onClick,
  busy,
}: {
  highlight: EventRow | null;
  onClick: () => void;
  busy?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="card p-4 border-dopamine-700 bg-dopamine-900/20" data-testid="random-panel">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-dopamine-200">
          {t('dopamine.remindWin')}
        </h2>
        <button
          type="button"
          onClick={onClick}
          disabled={busy}
          className="rounded bg-dopamine-600 hover:bg-dopamine-500 disabled:opacity-50 px-2.5 py-1 text-xs font-semibold text-white"
          data-testid="random-button"
        >
          {busy ? t('dopamine.thinking') : highlight ? t('dopamine.another') : t('dopamine.pickOne')}
        </button>
      </div>
      {highlight ? (
        <div className="mt-3" data-testid="random-highlight">
          <div className="text-base font-semibold text-slate-100">{highlight.title}</div>
          {highlight.body ? (
            <p className="text-xs text-slate-400 mt-1 whitespace-pre-wrap">{highlight.body}</p>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-slate-500 mt-2" data-testid="random-empty">
          {t('dopamine.randomEmpty')}
        </p>
      )}
    </div>
  );
}

function HomePage() {
  const data = Route.useLoaderData() as HomePayload | null;
  const router = useRouter();
  const [highlight, setHighlight] = useState<EventRow | null>(null);
  const [busy, setBusy] = useState(false);
  const { t } = useT();

  if (!data) {
    return (
      <div className="card p-4 text-sm text-slate-400 m-4" data-testid="no-session">
        {t('state.signedOut')}
      </div>
    );
  }

  /* v8 ignore start — server round-trip covered via deploy smoke. */
  async function handleRandom() {
    setBusy(true);
    try {
      const r = await fetchRandom({ data: { sinceDays: 90 } });
      setHighlight(r);
      router.invalidate();
    } finally {
      setBusy(false);
    }
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <RandomWinPanel highlight={highlight} onClick={handleRandom} busy={busy} />
        <h1 className="text-base font-semibold text-slate-200">{t('dopamine.recent')}</h1>
        {data.recent.length === 0 ? (
          <EmptyFeed />
        ) : (
          <ul className="space-y-2" data-testid="recent-list">
            {data.recent.map((e) => <EventCard key={e.id} event={e} />)}
          </ul>
        )}
      </div>
    </>
  );
}
