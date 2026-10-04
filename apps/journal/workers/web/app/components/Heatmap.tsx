import { intensityBucket } from '~/lib/format';
import { useT } from '@allenlabs/i18n/react';

interface HeatmapProps {
  /** 90 entries, oldest first, each with date + nullable composite score (3..15). */
  cells: Array<{ date: string; score: number | null }>;
}

const BUCKET_CLASSES = [
  'bg-slate-900 border border-slate-800',     // 0 — no entry
  'bg-journal-900',                            // 1
  'bg-journal-700',                            // 2
  'bg-journal-500',                            // 3
  'bg-journal-300',                            // 4
];

/**
 * 90-day grid.  Cells without entries render faded (bucket 0), but NEVER as
 * a "streak break".  This is intentional — the entire app is built around
 * not shaming missed days.
 */
export function Heatmap({ cells }: HeatmapProps) {
  const { t } = useT();
  return (
    <div className="card p-3" data-testid="heatmap">
      <div className="grid grid-cols-15 gap-1 sm:grid-cols-30">
        {cells.map((c) => {
          const bucket = intensityBucket(c.score);
          const cls = BUCKET_CLASSES[bucket]!;
          return (
            <div
              key={c.date}
              title={`${c.date}${c.score == null ? '' : ` · score ${c.score}`}`}
              className={`aspect-square rounded-sm ${cls}`}
              data-testid={`heatmap-cell-${c.date}`}
              data-bucket={bucket}
            />
          );
        })}
      </div>
      <div className="mt-3 text-xs text-slate-500 flex items-center gap-2">
        <span>{t('journal.heatmapLess')}</span>
        {BUCKET_CLASSES.map((cls, i) => (
          <div key={i} className={`h-3 w-3 rounded-sm ${cls}`} />
        ))}
        <span>{t('journal.heatmapMore')}</span>
      </div>
    </div>
  );
}
