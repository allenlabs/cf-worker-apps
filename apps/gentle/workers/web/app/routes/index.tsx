import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { useState } from 'react';
import {
  checkinSchema,
  loadHomeImpl,
  type HomePayload,
  upsertCheckinImpl,
} from '~/server/gentle';
import { getDb, requireUser, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { todayUtcIso } from '~/lib/format';
import { Header } from '~/components/Header';
import { CheckinForm, type CheckinFormValues } from '~/components/CheckinForm';
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
    return upsertCheckinImpl(getDb(), me.id, data);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => loadHome(),
  component: HomePage,
});

export function GentleHint({ hasToday }: { hasToday: boolean }) {
  const { t } = useT();
  if (hasToday) {
    return (
      <div className="card p-3 text-sm text-slate-400" data-testid="checked-in-hint">
        {t('gentle.hint.checkedIn')}
      </div>
    );
  }
  return (
    <div className="card p-3 text-sm text-slate-400" data-testid="not-yet-hint">
      {t('gentle.hint.notYet')}
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
    return <div className="p-6 text-slate-400">{t('gentle.loading')}</div>;
  }

  /* v8 ignore start */
  async function handleSubmit(values: CheckinFormValues) {
    setError(null);
    setBusy(true);
    try {
      await saveCheckin({
        data: {
          slept_ok: values.slept_ok,
          meds: values.meds,
          ate: values.ate,
          moved: values.moved,
          talked: values.talked,
          note: values.note || null,
          date: values.date,
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
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-200">{date}</h1>
          <span className="text-xs text-slate-500">{t('gentle.checkInLabel')}</span>
        </div>
        <CheckinForm
          initial={data.today}
          date={date}
          onSubmit={handleSubmit}
          busy={busy}
          error={error}
        />
        <GentleHint hasToday={data.today != null} />
      </div>
    </>
  );
}
