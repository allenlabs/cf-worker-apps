import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { useEffect, useState } from 'react';
import {
  loadTodayImpl,
  pickOneNextAction,
  type OneNextAction,
  type OneNextActionKind,
  type TodayPayload,
} from '~/server/today';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { clockTime, humanMinutes, timeAgo } from '~/lib/format';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
// Server function: today payload.  Verifies the JWT, then dispatches to
// loadTodayImpl which does the rest in one Hetzner round-trip.
const loadToday = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  const req = getRequest();
  const cookie = req?.headers.get('cookie') ?? null;
  const token = readSessionToken(cookie);
  if (!token) return null;
  const payload = await verifySessionToken(env, token);
  if (!payload?.sub) return null;
  return loadTodayImpl(getDb(), payload.sub);
});
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => {
    const data = await loadToday();
    if (!data) return null;
    const action = pickOneNextAction(data);
    return { data, action };
  },
  component: TodayPage,
});

// ---------- helpers exported for tests ----------

const KIND_LABEL: Record<OneNextActionKind, string> = {
  focus: 'IN A FOCUS SESSION',
  overdue: 'OVERDUE',
  'due-today': 'DUE TODAY',
  inbox: 'FROM INBOX',
};

const KIND_KEY: Record<OneNextActionKind, string> = {
  focus: 'today.kind.focus',
  overdue: 'today.kind.overdue',
  'due-today': 'today.kind.dueToday',
  inbox: 'today.kind.inbox',
};

// When a translator `t` is supplied (from the component), returns the
// localized label; otherwise falls back to the English literal so the pure
// unit test (which calls kindLabel(kind) with no translator) keeps passing.
export function kindLabel(kind: OneNextActionKind, t?: (key: string) => string): string {
  if (t) return t(KIND_KEY[kind]);
  return KIND_LABEL[kind];
}

export function sumHeatmap(days: number[]): number {
  return days.reduce((a, b) => a + b, 0);
}

export function maxHeatmap(days: number[]): number {
  return days.reduce((a, b) => (b > a ? b : a), 0);
}

// ---------- presentational pieces (exported for unit tests) ----------

interface HeroCardProps {
  action: OneNextAction | null;
  activeFocus: TodayPayload['activeFocus'];
}

export function HeroCard({ action, activeFocus }: HeroCardProps) {
  const { t } = useT();
  if (!action) {
    return (
      <section
        className="text-center py-16 px-6"
        data-testid="hero-empty"
      >
        <div className="text-sm uppercase tracking-widest text-slate-500 mb-4">
          🎯 {t('today.oneNextAction')}
        </div>
        <h1 className="text-3xl text-slate-300 mb-3">{t('today.quiet')}</h1>
        <p className="text-slate-500 max-w-md mx-auto">
          {t('today.quietHint')}
        </p>
      </section>
    );
  }
  return (
    <section
      className="text-center py-12 px-6"
      data-testid="hero"
      data-kind={action.kind}
    >
      <div className="text-sm uppercase tracking-widest text-slate-400 mb-4">
        🎯 {t('today.oneNextAction')} · <span className="text-amber-400">{kindLabel(action.kind, t)}</span>
      </div>
      <h1 className="text-4xl sm:text-5xl font-semibold text-slate-100 mb-8 leading-tight max-w-3xl mx-auto break-words">
        {action.label}
      </h1>
      <a
        href={action.url}
        className="inline-block rounded bg-amber-600 hover:bg-amber-500 px-6 py-3 text-base font-medium text-white"
        data-testid="hero-cta"
      >
        {t('today.takeMeThere')}
      </a>
      {activeFocus ? <ActiveFocusFooter activeFocus={activeFocus} /> : null}
    </section>
  );
}

interface ActiveFocusFooterProps {
  activeFocus: NonNullable<TodayPayload['activeFocus']>;
  nowOverride?: number;
}

export function ActiveFocusFooter({ activeFocus, nowOverride }: ActiveFocusFooterProps) {
  const { t } = useT();
  const [now, setNow] = useState<number>(nowOverride ?? Date.now());
  useEffect(() => {
    /* v8 ignore next 5 — exercised by deploy smoke; the interval just
       drives the label refresh and adding RTL fake timers here would
       complicate every render-only assertion. */
    if (nowOverride !== undefined) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [nowOverride]);
  const endsAtMs = new Date(activeFocus.endsAt).getTime();
  const remainingMs = Math.max(0, endsAtMs - now);
  const m = Math.floor(remainingMs / 60_000);
  const s = Math.floor((remainingMs % 60_000) / 1000);
  return (
    <div className="mt-6 text-sm text-slate-400" data-testid="active-footer">
      <span className="tabular-nums text-amber-300">
        {m}:{String(s).padStart(2, '0')}
      </span>
      <span className="mx-2">·</span>
      <span>{t('today.endsAt', { time: clockTime(activeFocus.endsAt) })}</span>
    </div>
  );
}

interface SparklineProps {
  days: number[];
}

const SPARK_WIDTH = 140;
const SPARK_HEIGHT = 32;

export function Sparkline({ days }: SparklineProps) {
  const { t } = useT();
  const max = maxHeatmap(days);
  const cellWidth = SPARK_WIDTH / Math.max(1, days.length);
  return (
    <svg
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      role="img"
      aria-label={t('today.sparklineLabel')}
      data-testid="sparkline"
    >
      {days.map((v, i) => {
        const h = max === 0 ? 0 : Math.max(2, (v / max) * SPARK_HEIGHT);
        return (
          <rect
            key={i}
            x={i * cellWidth + 1}
            y={SPARK_HEIGHT - h}
            width={Math.max(1, cellWidth - 2)}
            height={h}
            className={v > 0 ? 'fill-amber-500' : 'fill-slate-700'}
            data-testid={`spark-${i}`}
          />
        );
      })}
    </svg>
  );
}

interface SectionProps {
  title: string;
  badge?: string | number;
  defaultOpen?: boolean;
  children: React.ReactNode;
  testId: string;
}

export function Section({ title, badge, defaultOpen = false, children, testId }: SectionProps) {
  return (
    <details className="card p-4" data-testid={testId} open={defaultOpen ? true : undefined}>
      <summary className="cursor-pointer text-sm font-medium text-slate-200 flex items-center justify-between">
        <span>{title}</span>
        {badge !== undefined && badge !== '' && badge !== 0 ? (
          <span className="text-xs text-slate-400 bg-slate-800 rounded px-2 py-0.5 ml-2">
            {badge}
          </span>
        ) : null}
      </summary>
      <div className="mt-3 text-sm text-slate-300">{children}</div>
    </details>
  );
}

interface FocusPanelProps {
  focusToday: TodayPayload['focusToday'];
  focusHeatmap: TodayPayload['focusHeatmap'];
}

export function FocusPanel({ focusToday, focusHeatmap }: FocusPanelProps) {
  const { t } = useT();
  return (
    <Section
      title={t('today.focusToday')}
      badge={humanMinutes(focusToday.totalMinutes)}
      testId="focus-panel"
    >
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="text-xs text-slate-500">{t('today.sessions')}</div>
          <div className="text-lg font-semibold text-slate-100">{focusToday.sessionCount}</div>
        </div>
        <Sparkline days={focusHeatmap.days} />
      </div>
      <a
        href="https://focus.allenlabs.org/"
        className="mt-3 inline-block text-xs text-amber-400 hover:underline"
      >
        {t('today.openFocus')}
      </a>
    </Section>
  );
}

interface InboxPanelProps {
  inboxCount: TodayPayload['inboxCount'];
  inboxUnread: TodayPayload['inboxUnread'];
}

export function InboxPanel({ inboxCount, inboxUnread }: InboxPanelProps) {
  const { t } = useT();
  return (
    <Section title={t('today.inbox')} badge={inboxCount.unread} testId="inbox-panel">
      {inboxUnread.length === 0 ? (
        <p className="text-xs text-slate-500">{t('today.nothingUnread')}</p>
      ) : (
        <ul className="space-y-1" data-testid="inbox-list">
          {inboxUnread.slice(0, 5).map((it) => (
            <li
              key={it.id}
              className="text-xs text-slate-300 truncate"
              data-testid={`inbox-${it.id}`}
            >
              {it.text}
            </li>
          ))}
        </ul>
      )}
      <a
        href="https://inbox.allenlabs.org/"
        className="mt-3 inline-block text-xs text-amber-400 hover:underline"
      >
        {t('today.openInbox')}
      </a>
    </Section>
  );
}

interface PmPanelProps {
  pmAssigned: TodayPayload['pmAssigned'];
}

export function PmPanel({ pmAssigned }: PmPanelProps) {
  const { t } = useT();
  return (
    <Section
      title={t('today.assignedToMe')}
      badge={pmAssigned.length}
      testId="pm-panel"
    >
      {pmAssigned.length === 0 ? (
        <p className="text-xs text-slate-500">{t('today.nothingAssigned')}</p>
      ) : (
        <ul className="space-y-2" data-testid="pm-list">
          {pmAssigned.slice(0, 8).map((i) => (
            <li
              key={i.id}
              className="text-xs"
              data-testid={`pm-${i.id}`}
            >
              <a
                href={`https://projects.allenlabs.org/projects/${i.projectIdentifier}/issues/${i.id}`}
                className="text-slate-200 hover:underline"
              >
                {i.subject}
              </a>
              <span className="ml-2 text-slate-500">
                {i.projectIdentifier}
                {i.dueDate ? <> · {t('today.due', { date: i.dueDate })}</> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

interface ActivityPanelProps {
  recentActivity: TodayPayload['recentActivity'];
}

export function ActivityPanel({ recentActivity }: ActivityPanelProps) {
  const { t } = useT();
  return (
    <Section
      title={t('today.recentActivity')}
      badge={recentActivity.length}
      testId="activity-panel"
    >
      {recentActivity.length === 0 ? (
        <p className="text-xs text-slate-500">{t('today.noActivity')}</p>
      ) : (
        <ul className="space-y-1" data-testid="activity-list">
          {recentActivity.slice(0, 8).map((a) => (
            <li
              key={a.id}
              className="text-xs text-slate-300 flex items-center justify-between gap-2"
              data-testid={`activity-${a.id}`}
            >
              <span className="truncate">
                <span className="text-slate-500 mr-1">{a.kind}</span>
                {a.title}
              </span>
              <span className="text-slate-500 text-[10px] flex-shrink-0">
                {timeAgo(a.createdAt)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

// ---------- page component ----------

/* v8 ignore start — the page composition is exercised by deploy smoke
   + render integration; the unit-tested pure pieces are HeroCard, the
   per-panel components, and pickOneNextAction. */
function TodayPage() {
  const loaderData = Route.useLoaderData();
  const { t } = useT();

  if (!loaderData) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <p className="text-slate-400">{t('state.loading')}</p>
        <a href="/auth/login" className="text-amber-400 hover:underline text-sm">
          {t('nav.signIn')}
        </a>
      </div>
    );
  }
  const { data, action } = loaderData;

  return (
    <main className="max-w-5xl mx-auto px-6 py-8">
      <HeroCard action={action} activeFocus={data.activeFocus} />
      <section className="grid sm:grid-cols-2 gap-4 mt-12" data-testid="panels">
        <FocusPanel focusToday={data.focusToday} focusHeatmap={data.focusHeatmap} />
        <InboxPanel inboxCount={data.inboxCount} inboxUnread={data.inboxUnread} />
        <PmPanel pmAssigned={data.pmAssigned} />
        <ActivityPanel recentActivity={data.recentActivity} />
      </section>
      <footer className="mt-12 text-center text-xs text-slate-600">
        {t('today.signedInAs', { name: data.me.login })}{' '}
        <a href="/auth/logout" className="hover:underline">
          {t('nav.signOut')}
        </a>
      </footer>
    </main>
  );
}
/* v8 ignore stop */
