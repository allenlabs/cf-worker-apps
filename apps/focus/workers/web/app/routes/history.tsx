import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import { useState } from 'react';
import {
  loadDaySessionsImpl,
  loadHistoryImpl,
  type FocusSessionRow,
  type HeatmapDay,
  type HistoryPayload,
} from '~/server/focus';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { clockTime, humanMinutes } from '~/lib/format';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const loadHistory = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  const req = getRequest();
  const cookie = req?.headers.get('cookie') ?? null;
  const token = readSessionToken(cookie);
  if (!token) return null;
  const payload = await verifySessionToken(env, token);
  if (!payload?.sub) return null;
  return loadHistoryImpl(getDb(), payload.sub);
});

const DayInput = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) });
const loadDay = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => DayInput.parse(data))
  .handler(async ({ data }) => {
    const env = getEnv();
    const req = getRequest();
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    if (!token) return [];
    const payload = await verifySessionToken(env, token);
    if (!payload?.sub) return [];
    const db = getDb();
    const me = await findUserBySsoImpl(db, payload.sub);
    if (!me) return [];
    return loadDaySessionsImpl(db, me.id, data.day);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/history')({
  loader: async () => {
    const data = await loadHistory();
    return data;
  },
  component: HistoryPage,
});

// ---------- helpers exported for tests ----------

/**
 * Map a per-day minute count to a 0-4 intensity bucket.  Deliberately
 * coarse: ADHD users don't need (and shouldn't compare) fine-grained
 * "I did 67 vs 73 minutes" — they need "I touched this day at all".
 *
 *   0      → not touched
 *   1-15   → bucket 1
 *   16-30  → bucket 2
 *   31-60  → bucket 3
 *   61+    → bucket 4
 */
export function intensityBucket(minutes: number): 0 | 1 | 2 | 3 | 4 {
  if (minutes <= 0) return 0;
  if (minutes <= 15) return 1;
  if (minutes <= 30) return 2;
  if (minutes <= 60) return 3;
  return 4;
}

export function heatmapCellClass(bucket: 0 | 1 | 2 | 3 | 4): string {
  switch (bucket) {
    case 0:
      return 'fill-slate-800';
    case 1:
      return 'fill-focus-900';
    case 2:
      return 'fill-focus-700';
    case 3:
      return 'fill-focus-500';
    case 4:
      return 'fill-focus-300';
  }
}

interface HeatmapProps {
  days: HeatmapDay[];
  onSelectDay: (day: string) => void;
}

const CELL = 12;
const GAP = 2;

export function Heatmap({ days, onSelectDay }: HeatmapProps) {
  const { t } = useT();
  // Lay out as 13 columns x 7 rows.  Each column is a week, oldest left.
  const weeks = Math.ceil(days.length / 7);
  const width = weeks * (CELL + GAP);
  const height = 7 * (CELL + GAP);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={t('focus.heatmapLabel')}
      data-testid="heatmap"
    >
      {days.map((d, i) => {
        const col = Math.floor(i / 7);
        const row = i % 7;
        const bucket = intensityBucket(d.minutes);
        return (
          <rect
            key={d.date}
            x={col * (CELL + GAP)}
            y={row * (CELL + GAP)}
            width={CELL}
            height={CELL}
            className={`${heatmapCellClass(bucket)} cursor-pointer hover:opacity-80`}
            data-date={d.date}
            data-bucket={bucket}
            data-testid={`cell-${d.date}`}
            onClick={() => onSelectDay(d.date)}
          >
            <title>{t('focus.sessionTitle', { date: d.date, minutes: humanMinutes(d.minutes), sessions: t(d.sessions === 1 ? 'focus.sessionOne' : 'focus.sessionMany', { n: d.sessions }) })}</title>
          </rect>
        );
      })}
    </svg>
  );
}

interface DayDetailProps {
  day: string;
  sessions: FocusSessionRow[];
}

export function DayDetail({ day, sessions }: DayDetailProps) {
  const { t } = useT();
  if (sessions.length === 0) {
    return (
      <div className="card p-4 text-sm text-slate-400" data-testid="day-empty">
        {t('focus.dayEmpty', { day })}
      </div>
    );
  }
  return (
    <ul className="space-y-2" data-testid="day-detail">
      {sessions.map((s) => (
        <li key={s.id} className="card p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-slate-100 truncate">{s.taskText}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded ${
                s.endedReason === 'completed'
                  ? 'bg-emerald-900/60 text-emerald-300'
                  : s.endedReason === 'abandoned'
                  ? 'bg-slate-800 text-slate-400'
                  : 'bg-focus-900/60 text-focus-300'
              }`}
            >
              {s.endedReason ?? t('focus.inProgress')}
            </span>
          </div>
          <div className="mt-1 text-xs text-slate-500 flex flex-wrap gap-2">
            <span>{clockTime(s.startedAt)}{s.endedAt ? ` → ${clockTime(s.endedAt)}` : ''}</span>
            <span>· {humanMinutes(s.targetMinutes)}</span>
            {s.distractionCount > 0 ? (
              <span>· {t(s.distractionCount === 1 ? 'focus.wobbleOne' : 'focus.wobbleMany', { n: s.distractionCount })}</span>
            ) : null}
            {s.satisfaction ? <span>· {'★'.repeat(s.satisfaction)}</span> : null}
          </div>
          {s.notes ? <div className="mt-2 text-xs text-slate-300 whitespace-pre-wrap">{s.notes}</div> : null}
        </li>
      ))}
    </ul>
  );
}

function HistoryPage() {
  const data: HistoryPayload | null = Route.useLoaderData();
  const { t } = useT();
  const [selected, setSelected] = useState<{ day: string; rows: FocusSessionRow[] } | null>(null);
  /* v8 ignore next 6 — the click→fetch happens on real navigation; unit
     tests cover the pure pieces (heatmap, day detail). */
  const pickDay = async (day: string) => {
    const rows = await loadDay({ data: { day } });
    setSelected({ day, rows });
  };

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <h1 className="text-lg font-semibold text-slate-200 mb-1">{t('focus.historyTitle')}</h1>
      <p className="text-xs text-slate-500 mb-4">
        {t('focus.historySubtitle')}
      </p>
      <div className="mb-6 flex gap-6 text-xs text-slate-400">
        <span>{t('focus.total')} <span className="text-slate-200">{humanMinutes(data.totalMinutes)}</span></span>
        <span>{t('focus.sessionsLabel')} <span className="text-slate-200">{data.totalSessions}</span></span>
      </div>
      <div className="overflow-x-auto mb-6">
        <Heatmap days={data.days} onSelectDay={pickDay} />
      </div>
      {selected ? (
        <div>
          <h2 className="text-sm font-medium text-slate-300 mb-2">{selected.day}</h2>
          <DayDetail day={selected.day} sessions={selected.rows} />
        </div>
      ) : (
        <p className="text-xs text-slate-500">{t('focus.clickCell')}</p>
      )}
      <div className="mt-8 text-xs text-slate-500">
        <a href="/" className="hover:underline">{t('focus.backToFocus')}</a>
      </div>
    </div>
  );
}
