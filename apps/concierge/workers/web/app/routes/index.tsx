import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { loadHomeImpl, type HomePayload } from '~/server/home';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { NudgeRow, EmptyNudges } from '~/components/NudgeRow';
import { minutesToHHMM } from '~/lib/format';

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
  loader: async () => {
    return await loadHome();
  },
  component: HomePage,
});

function HomePage() {
  const data = Route.useLoaderData() as HomePayload | null;
  const [busy, setBusy] = useState(false);
  const { t } = useT();

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-slate-200">{t('concierge.title')}</h1>
        <p className="text-xs text-slate-500 mt-1">
          {t('concierge.tagline')}
        </p>
      </header>

      <PreferencesPanel
        preferences={data.preferences}
        busy={busy}
        setBusy={setBusy}
      />

      <section className="mt-8">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm uppercase tracking-wide text-slate-400">
            {t('concierge.recentNudges')}
          </h2>
          <ManualTriggerButton busy={busy} setBusy={setBusy} />
        </div>
        {data.nudges.length === 0 ? (
          <EmptyNudges />
        ) : (
          <ul className="space-y-2" data-testid="nudge-list">
            {data.nudges.map((n) => (
              <NudgeRow key={n.id} nudge={n} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* v8 ignore start — UI side-effects are deploy-tested. */
interface PreferencesPanelProps {
  preferences: HomePayload['preferences'];
  busy: boolean;
  setBusy: (b: boolean) => void;
}

function PreferencesPanel({ preferences, busy, setBusy }: PreferencesPanelProps) {
  const { t } = useT();
  const [enabled, setEnabled] = useState(preferences.enabled);
  const [cadence, setCadence] = useState(preferences.cadenceMinutes);
  const [qStart, setQStart] = useState(minutesToHHMM(preferences.quietStart));
  const [qEnd, setQEnd] = useState(minutesToHHMM(preferences.quietEnd));

  async function save() {
    setBusy(true);
    try {
      await fetch('/api/preferences', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          enabled,
          cadenceMinutes: cadence,
          quietStart: qStart || null,
          quietEnd: qEnd || null,
        }),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card p-4" data-testid="prefs">
      <h2 className="text-sm uppercase tracking-wide text-slate-400 mb-3">
        {t('concierge.preferences')}
      </h2>
      <label className="flex items-center gap-2 mb-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          data-testid="enabled-toggle"
        />
        <span className="text-sm">{t('concierge.prefsEnabled')}</span>
      </label>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <label className="flex flex-col">
          <span className="text-xs text-slate-500 mb-1">{t('concierge.cadence')}</span>
          <input
            type="number"
            min={15}
            max={1440}
            value={cadence}
            onChange={(e) => setCadence(Number(e.target.value))}
            className="bg-slate-900 border border-slate-800 rounded px-2 py-1"
          />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col">
            <span className="text-xs text-slate-500 mb-1">{t('concierge.quietStart')}</span>
            <input
              type="time"
              value={qStart}
              onChange={(e) => setQStart(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded px-2 py-1"
            />
          </label>
          <label className="flex flex-col">
            <span className="text-xs text-slate-500 mb-1">{t('concierge.quietEnd')}</span>
            <input
              type="time"
              value={qEnd}
              onChange={(e) => setQEnd(e.target.value)}
              className="bg-slate-900 border border-slate-800 rounded px-2 py-1"
            />
          </label>
        </div>
      </div>
      <button
        type="button"
        onClick={save}
        disabled={busy}
        data-testid="save-prefs"
        className="mt-4 px-3 py-2 rounded bg-conci-600 hover:bg-conci-500 disabled:opacity-50 text-sm font-medium"
      >
        {t('concierge.savePrefs')}
      </button>
    </section>
  );
}

function ManualTriggerButton({ busy, setBusy }: { busy: boolean; setBusy: (b: boolean) => void }) {
  const { t } = useT();
  return (
    <button
      type="button"
      data-testid="manual-trigger"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await fetch('/api/trigger', { method: 'POST' });
          window.location.reload();
        } finally {
          setBusy(false);
        }
      }}
      className="text-xs px-2 py-1 rounded border border-slate-700 hover:bg-slate-800"
    >
      {t('concierge.triggerOne')}
    </button>
  );
}
/* v8 ignore stop */
