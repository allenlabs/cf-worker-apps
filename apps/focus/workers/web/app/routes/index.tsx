import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { useEffect, useState } from 'react';
import {
  TARGET_MINUTES_OPTIONS,
  distractSchema,
  distractImpl,
  endSchema,
  endSessionImpl,
  loadHomeImpl,
  startSchema,
  startSessionImpl,
  type HomePayload,
} from '~/server/focus';
import { getDb, getEnv, requireUser } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { clockTime, humanMinutes, mmss } from '~/lib/format';
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

const startFromWeb = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => startSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    const r = await startSessionImpl(getDb(), me.id, data);
    return { id: r.id, startedAt: r.startedAt.toISOString(), endsAt: r.endsAt.toISOString() };
  });

const endFromWeb = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => endSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return endSessionImpl(getDb(), me.id, data);
  });

const distractFromWeb = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => distractSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return distractImpl(getDb(), me.id, data);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => {
    const data = await loadHome();
    return data;
  },
  component: HomePage,
});

// ---------- helpers + presentational pieces (exported for tests) ----------

export function computeRemainingSeconds(endsAt: string, now: number = Date.now()): number {
  const t = new Date(endsAt).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((t - now) / 1000));
}

export function ringDashOffset(elapsedFrac: number, circumference: number): number {
  const f = Math.max(0, Math.min(1, elapsedFrac));
  return f * circumference;
}

interface StartFormProps {
  initialTaskText?: string;
  inboxSuggestions: HomePayload['inboxSuggestions'];
  onStart: (input: { taskText: string; targetMinutes: number; inboxItemId?: number }) => void;
}

export function StartForm({ initialTaskText = '', inboxSuggestions, onStart }: StartFormProps) {
  const { t } = useT();
  const [taskText, setTaskText] = useState(initialTaskText);
  const [targetMinutes, setTargetMinutes] = useState<number>(25);
  const [inboxItemId, setInboxItemId] = useState<number | undefined>(undefined);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const t = taskText.trim();
        if (!t) return;
        const payload: { taskText: string; targetMinutes: number; inboxItemId?: number } = {
          taskText: t,
          targetMinutes,
        };
        if (inboxItemId !== undefined) payload.inboxItemId = inboxItemId;
        onStart(payload);
      }}
      className="space-y-4"
      data-testid="start-form"
    >
      <div>
        <label htmlFor="task" className="block text-sm text-slate-300 mb-1">
          {t('focus.taskQuestion')}
        </label>
        <input
          id="task"
          autoFocus
          value={taskText}
          onChange={(e) => setTaskText(e.target.value)}
          placeholder={t('focus.taskPlaceholder')}
          aria-label={t('focus.taskLabel')}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-focus-500 focus:outline-none"
        />
      </div>
      {inboxSuggestions.length > 0 ? (
        <fieldset className="text-xs text-slate-400" data-testid="inbox-suggestions">
          <legend className="mb-1">{t('focus.orPickInbox')}</legend>
          <div className="flex flex-wrap gap-1">
            {inboxSuggestions.map((s) => (
              <button
                type="button"
                key={s.id}
                onClick={() => {
                  setTaskText(s.text);
                  setInboxItemId(s.id);
                }}
                className="rounded border border-slate-700 bg-slate-900 hover:bg-slate-800 px-2 py-1 text-slate-300"
              >
                {s.text.length > 40 ? `${s.text.slice(0, 40)}…` : s.text}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}
      <div>
        <label className="block text-sm text-slate-300 mb-1">{t('focus.howLong')}</label>
        <div className="flex gap-2" role="radiogroup" aria-label={t('focus.targetMinutes')}>
          {TARGET_MINUTES_OPTIONS.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={targetMinutes === m}
              onClick={() => setTargetMinutes(m)}
              className={`rounded border px-3 py-1 text-sm ${
                targetMinutes === m
                  ? 'border-focus-500 bg-focus-900/40 text-focus-200'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {t('focus.minLabel', { n: m })}
            </button>
          ))}
        </div>
      </div>
      <button
        type="submit"
        className="rounded bg-focus-600 hover:bg-focus-500 px-4 py-2 text-sm font-medium text-white"
      >
        {t('focus.lockIn')}
      </button>
    </form>
  );
}

interface CountdownProps {
  endsAt: string;
  targetMinutes: number;
  // for tests
  nowOverride?: number;
}

const RING_RADIUS = 90;
const RING_CIRC = 2 * Math.PI * RING_RADIUS;

export function Countdown({ endsAt, targetMinutes, nowOverride }: CountdownProps) {
  const { t } = useT();
  const [now, setNow] = useState<number>(nowOverride ?? Date.now());
  useEffect(() => {
    /* v8 ignore next 5 — exercised by deploy smoke tests; the impl is the
       trivial setInterval below and adding RTL fake timers here would
       complicate every render-only assertion. */
    if (nowOverride !== undefined) return; // tests freeze time
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [nowOverride]);
  const remaining = computeRemainingSeconds(endsAt, now);
  const totalSeconds = targetMinutes * 60;
  const elapsed = totalSeconds === 0 ? 1 : (totalSeconds - remaining) / totalSeconds;
  const offset = ringDashOffset(elapsed, RING_CIRC);
  return (
    <div className="relative w-56 h-56 mx-auto" data-testid="countdown">
      <svg viewBox="0 0 200 200" className="w-full h-full ring-sweep">
        <circle cx="100" cy="100" r={RING_RADIUS}
          stroke="#1e293b" strokeWidth="10" fill="none" />
        <circle cx="100" cy="100" r={RING_RADIUS}
          stroke="#f59e0b" strokeWidth="10" fill="none"
          strokeDasharray={RING_CIRC}
          strokeDashoffset={RING_CIRC - offset}
          strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <div className="text-5xl font-bold tabular-nums text-focus-200" data-testid="countdown-mmss">
          {mmss(remaining)}
        </div>
        <div className="text-xs text-slate-400 mt-1">
          {t('focus.endsAt')} <span className="text-slate-200">{clockTime(endsAt)}</span>
        </div>
      </div>
    </div>
  );
}

interface ActiveSessionViewProps {
  active: NonNullable<HomePayload['active']>;
  todayDistractionCount: number;
  onDistract: (label: string) => void;
  onEnd: (reason: 'completed' | 'abandoned') => void;
  onExtend: () => void;
}

export function ActiveSessionView({
  active,
  todayDistractionCount,
  onDistract,
  onEnd,
  onExtend,
}: ActiveSessionViewProps) {
  const { t } = useT();
  const [wobbleOpen, setWobbleOpen] = useState(false);
  const [wobbleLabel, setWobbleLabel] = useState('');
  return (
    <div className="max-w-md mx-auto p-6 text-center" data-testid="active-view">
      <div className="text-sm uppercase tracking-wide text-focus-400 mb-2">{t('focus.lockedIn')}</div>
      <h1 className="text-xl font-semibold text-slate-100 mb-6">{active.taskText}</h1>
      <Countdown endsAt={active.endsAt} targetMinutes={active.targetMinutes} />
      <div className="mt-6 flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setWobbleOpen(true)}
          className="rounded border border-slate-700 bg-slate-900 hover:bg-slate-800 px-4 py-2 text-sm text-slate-200"
          data-testid="note-wobble"
        >
          {t('focus.noteWobble')}
        </button>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => onExtend()}
            className="rounded border border-focus-700 bg-focus-900/40 hover:bg-focus-900 px-4 py-2 text-sm text-focus-200"
            data-testid="extend"
          >
            {t('focus.extend')}
          </button>
          <button
            type="button"
            onClick={() => onEnd('completed')}
            className="rounded bg-emerald-700 hover:bg-emerald-600 px-4 py-2 text-sm text-white"
            data-testid="done-early"
          >
            {t('focus.doneEarly')}
          </button>
        </div>
        <button
          type="button"
          onClick={() => onEnd('abandoned')}
          className="text-xs text-slate-500 hover:text-slate-300 underline mt-2"
          data-testid="step-away"
        >
          {t('focus.stepAway')}
        </button>
      </div>
      {todayDistractionCount > 0 ? (
        <div className="mt-4 text-xs text-slate-500" data-testid="distractions-today">
          {t(todayDistractionCount === 1 ? 'focus.wobbleNotedOne' : 'focus.wobbleNotedMany', { n: todayDistractionCount })}
        </div>
      ) : null}
      {wobbleOpen ? (
        <div
          className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50"
          data-testid="wobble-modal"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const v = wobbleLabel.trim();
              if (!v) return;
              onDistract(v);
              setWobbleLabel('');
              setWobbleOpen(false);
            }}
            className="card p-6 max-w-sm w-full"
          >
            <h2 className="text-sm font-medium text-slate-200 mb-3">{t('focus.noteWobble')}</h2>
            <input
              autoFocus
              value={wobbleLabel}
              onChange={(e) => setWobbleLabel(e.target.value)}
              placeholder={t('focus.wobblePlaceholder')}
              aria-label={t('focus.wobbleLabel')}
              className="w-full rounded bg-slate-950 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-focus-500 focus:outline-none"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setWobbleOpen(false)}
                className="text-sm text-slate-400 hover:text-slate-200"
              >
                {t('btn.cancel')}
              </button>
              <button
                type="submit"
                className="rounded bg-focus-600 hover:bg-focus-500 px-3 py-1.5 text-sm text-white"
              >
                {t('focus.noteIt')}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}

interface ReflectionViewProps {
  onSave: (input: { notes: string; satisfaction: number }) => void;
  onSkip: () => void;
}

export function ReflectionView({ onSave, onSkip }: ReflectionViewProps) {
  const { t } = useT();
  const [notes, setNotes] = useState('');
  const [satisfaction, setSatisfaction] = useState(0);
  return (
    <div className="max-w-md mx-auto p-6" data-testid="reflection-view">
      <h2 className="text-lg font-semibold text-emerald-300 mb-1">
        {t('focus.reflectTitle')}
      </h2>
      <p className="text-sm text-slate-400 mb-6">
        {t('focus.reflectHint')}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ notes: notes.trim(), satisfaction });
        }}
        className="space-y-4"
      >
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={t('focus.reflectNotesPlaceholder')}
          aria-label={t('focus.reflectNotesLabel')}
          rows={4}
          className="w-full rounded bg-slate-900 border border-slate-700 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-focus-500 focus:outline-none"
        />
        <div>
          <div className="text-xs text-slate-400 mb-1">{t('focus.howFeel')}</div>
          <div className="flex gap-1" role="radiogroup" aria-label={t('focus.satisfaction')}>
            {[1, 2, 3, 4, 5].map((n) => (
              <button
                key={n}
                type="button"
                role="radio"
                aria-checked={satisfaction === n}
                onClick={() => setSatisfaction(n)}
                className={`w-10 h-10 rounded border text-lg ${
                  satisfaction >= n
                    ? 'border-focus-500 bg-focus-900/40 text-focus-200'
                    : 'border-slate-700 bg-slate-900 text-slate-500 hover:bg-slate-800'
                }`}
                data-testid={`star-${n}`}
              >
                ★
              </button>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onSkip}
            className="text-sm text-slate-400 hover:text-slate-200"
          >
            {t('focus.skip')}
          </button>
          <button
            type="submit"
            className="rounded bg-focus-600 hover:bg-focus-500 px-4 py-2 text-sm text-white"
            disabled={satisfaction === 0}
          >
            {t('btn.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

export function TodayStats({
  todayFocusedMinutes,
  todaySessionsCount,
  todayDistractionCount,
}: Pick<HomePayload, 'todayFocusedMinutes' | 'todaySessionsCount' | 'todayDistractionCount'>) {
  const { t } = useT();
  return (
    <div className="grid grid-cols-3 gap-2 mb-6 text-center" data-testid="today-stats">
      <div className="card p-3">
        <div className="text-xs text-slate-500">{t('focus.statFocusedToday')}</div>
        <div className="text-lg font-semibold text-focus-300 mt-1">{humanMinutes(todayFocusedMinutes)}</div>
      </div>
      <div className="card p-3">
        <div className="text-xs text-slate-500">{t('focus.statSessions')}</div>
        <div className="text-lg font-semibold text-slate-200 mt-1">{todaySessionsCount}</div>
      </div>
      <div className="card p-3">
        <div className="text-xs text-slate-500">{t('focus.statWobbles')}</div>
        <div className="text-lg font-semibold text-slate-200 mt-1">{todayDistractionCount}</div>
      </div>
    </div>
  );
}

// ---------- page component ----------

function HomePage() {
  const data = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  // After "Done early" or "Step away" we briefly show the reflection card
  // (a recently-ended session id) before the home loader rolls forward.
  const [justEndedId, setJustEndedId] = useState<number | null>(null);

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  if (justEndedId !== null) {
    return (
      <ReflectionView
        onSave={async ({ notes, satisfaction }) => {
          /* v8 ignore next 9 — exercised by deploy smoke. */
          await endFromWeb({
            data: {
              sessionId: justEndedId,
              endedReason: 'completed',
              notes,
              satisfaction,
            },
          });
          setJustEndedId(null);
          router.invalidate();
        }}
        onSkip={() => {
          setJustEndedId(null);
          router.invalidate();
        }}
      />
    );
  }

  if (data.active) {
    return (
      <ActiveSessionView
        active={data.active}
        todayDistractionCount={data.todayDistractionCount}
        onDistract={(label) => {
          /* v8 ignore next 3 */
          void distractFromWeb({ data: { sessionId: data.active!.id, label } }).then(() =>
            router.invalidate(),
          );
        }}
        onExtend={() => {
          /* v8 ignore next 4 */
          void endFromWeb({
            data: { sessionId: data.active!.id, endedReason: 'extended' },
          }).then(() => router.invalidate());
        }}
        onEnd={(reason) => {
          /* v8 ignore next 8 */
          const id = data.active!.id;
          void endFromWeb({
            data: { sessionId: id, endedReason: reason },
          }).then(() => {
            if (reason === 'completed') setJustEndedId(id);
            else router.invalidate();
          });
        }}
      />
    );
  }

  return (
    <div className="max-w-md mx-auto p-6">
      <h1 className="text-lg font-semibold text-slate-200 mb-1">{t('focus.title')}</h1>
      <p className="text-xs text-slate-500 mb-6">
        {t('focus.subtitle')}
      </p>
      <TodayStats
        todayFocusedMinutes={data.todayFocusedMinutes}
        todaySessionsCount={data.todaySessionsCount}
        todayDistractionCount={data.todayDistractionCount}
      />
      <StartForm
        initialTaskText={data.lastAbandonedTaskText ?? ''}
        inboxSuggestions={data.inboxSuggestions}
        onStart={(input) => {
          /* v8 ignore next 3 */
          void startFromWeb({ data: input }).then(() => router.invalidate());
        }}
      />
      <div className="mt-8 text-xs text-slate-500">
        <a href="/history" className="hover:underline">{t('focus.viewHistory')}</a>
      </div>
    </div>
  );
}
