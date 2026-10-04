import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import {
  checkinSchema,
  loadHomeImpl,
  type HomePayload,
  upsertCheckinImpl,
} from '~/server/journal';
import { getDb, requireUser, getEnv } from '~/server/auth-runtime.server';
import { getRequest } from '@tanstack/react-start/server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { todayUtcIso } from '~/lib/format';
import { Header } from '~/components/Header';
import { CheckinForm } from '~/components/CheckinForm';
import { useT } from '@allenlabs/i18n/react';

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

const saveCheckin = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => checkinSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return upsertCheckinImpl(getDb(), me.id, { ...data, source: data.source ?? 'web' });
  });
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => loadHome(),
  component: HomePage,
});

export function EmptyToday() {
  const { t } = useT();
  return (
    <div className="card p-4 text-sm text-slate-400" data-testid="empty-today">
      {t('journal.emptyToday')}
    </div>
  );
}

function HomePage() {
  const data = Route.useLoaderData() as HomePayload | null;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const date = todayUtcIso();
  const { t } = useT();

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  /* v8 ignore start — server round-trip covered via deploy smoke. */
  async function handleSubmit(values: {
    mood: number; energy: number; focus: number; mind: string; blockers: string; date: string;
  }) {
    setError(null);
    setBusy(true);
    try {
      await saveCheckin({
        data: {
          mood: values.mood,
          energy: values.energy,
          focus: values.focus,
          mind: values.mind || null,
          blockers: values.blockers || null,
          date: values.date,
          source: 'web',
        },
      });
      router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <h1 className="text-base font-semibold text-slate-200">{date}</h1>
        <CheckinForm
          initial={data.today}
          date={date}
          onSubmit={handleSubmit}
          busy={busy}
          error={error}
        />
        {!data.today ? <EmptyToday /> : null}
      </div>
    </>
  );
}
