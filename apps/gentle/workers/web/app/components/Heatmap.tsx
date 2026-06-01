import { intensityBucket } from '~/lib/format';
import { useT } from '@allenlabs/i18n/react';

interface HeatmapProps {
  /** 90 entries (or however many `from`..`to` covers).  Score is the
   *  count of TRUE toggles (0-5) for the day, or null if no entry. */
  cells: Array<{ date: string; score: number | null }>;
}

const BUCKET_CLASSES = [
  'bg-slate-900 border border-slate-800',  // 0 — no entry (faded, never a "break")
  'bg-gentle-900',                          // 1
  'bg-gentle-700',                          // 2
  'bg-gentle-500',                          // 3
  'bg-gentle-400',                          // 4
  'bg-gentle-300',                          // 5 — all five toggles flipped
];

/**
 * 90-day grid.  Cells without entries render faded (bucket 0).  This is
 * deliberate — gentle never "resets a streak"; missed days are visually
 * gentle, not punishing.
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
              title={c.score == null ? c.date : t('gentle.heatmap.score', { date: c.date, n: c.score })}
              className={`aspect-square rounded-sm ${cls}`}
              data-testid={`heatmap-cell-${c.date}`}
              data-bucket={bucket}
            />
          );
        })}
      </div>
      <div className="mt-3 text-xs text-slate-500 flex items-center gap-2">
        <span>{t('gentle.heatmap.quiet')}</span>
        {BUCKET_CLASSES.map((cls, i) => (
          <div key={i} className={`h-3 w-3 rounded-sm ${cls}`} />
        ))}
        <span>{t('gentle.heatmap.full')}</span>
      </div>
    </div>
  );
}
