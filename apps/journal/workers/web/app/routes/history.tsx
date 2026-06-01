import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { statsImpl, type JournalStats } from '~/server/journal';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { Heatmap } from '~/components/Heatmap';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const loadStats = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await requireUser();
  return statsImpl(getDb(), me.id);
});
/* v8 ignore stop */

export const Route = createFileRoute('/history')({
  loader: async () => loadStats(),
  component: HistoryPage,
});

interface StatTileProps {
  label: string;
  value: string;
}

export function StatTile({ label, value }: StatTileProps) {
  return (
    <div className="card p-3" data-testid={`stat-${label}`}>
      <div className="text-xs text-slate-400">{label}</div>
      <div className="text-lg text-slate-100 mt-1">{value}</div>
    </div>
  );
}

function HistoryPage() {
  const data = Route.useLoaderData() as JournalStats;
  const a = data.averages;
  const { t } = useT();
  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatTile label={t('journal.statEntries')} value={String(data.total)} />
          <StatTile label={t('journal.statAvgMood')} value={a.mood == null ? '—' : String(a.mood)} />
          <StatTile label={t('journal.statAvgEnergy')} value={a.energy == null ? '—' : String(a.energy)} />
          <StatTile label={t('journal.statAvgFocus')} value={a.focus == null ? '—' : String(a.focus)} />
        </div>
        <p className="text-xs text-slate-500">
          {t('journal.last90Days')}
        </p>
        <Heatmap cells={data.heatmap} />
        <p className="text-xs text-slate-500">
          <Link to="/entry/$date" params={{ date: data.heatmap.at(-1)?.date ?? '' }}>
            {t('journal.viewToday')}
          </Link>
        </p>
      </div>
    </>
  );
}
