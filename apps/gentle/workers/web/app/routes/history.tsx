import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import {
  rangeHeatmapImpl,
  type HeatmapCell,
} from '~/server/gentle';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { lastNDays } from '~/lib/format';
import { Header } from '~/components/Header';
import { Heatmap } from '~/components/Heatmap';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const loadHeatmap = createServerFn({ method: 'GET' }).handler(async (): Promise<HeatmapCell[]> => {
  const me = await requireUser();
  const { from, to } = lastNDays(90);
  return rangeHeatmapImpl(getDb(), me.id, from, to);
});
/* v8 ignore stop */

export const Route = createFileRoute('/history')({
  loader: async () => loadHeatmap(),
  component: HistoryPage,
});

function HistoryPage() {
  const cells = Route.useLoaderData() as HeatmapCell[];
  const { t } = useT();
  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <h1 className="text-base font-semibold text-slate-200">{t('gentle.history.title')}</h1>
        <p className="text-xs text-slate-500">
          {t('gentle.history.subtitle')}
        </p>
        <Heatmap cells={cells} />
      </div>
    </>
  );
}
