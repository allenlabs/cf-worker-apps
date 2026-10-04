import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import {
  dismissReminderImpl,
  loadHomeImpl,
  snoozeReminderImpl,
  type HomePayload,
} from '~/server/nudge';
import { getDb, getEnv, requireUser } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { Header } from '~/components/Header';
import { ReminderRowCard } from '~/components/ReminderRow';
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

const dismissReminder = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => z.object({ id: z.number().int().positive() }).parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return dismissReminderImpl(getDb(), me.id, data.id);
  });

const snoozeReminder = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) =>
    z.object({ id: z.number().int().positive(), minutes: z.number().int().positive() }).parse(data),
  )
  .handler(async ({ data }) => {
    const me = await requireUser();
    return snoozeReminderImpl(getDb(), me.id, data.id, data.minutes);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => {
    const data = await loadHome();
    return data;
  },
  component: HomePage,
});

export function EmptyState() {
  const { t } = useT();
  return (
    <div className="card p-6 text-center text-sm text-slate-400" data-testid="empty-state">
      <p className="mb-2 text-slate-200">{t('nudge.allClear')}</p>
      <p className="text-xs">
        {t('nudge.allClearHint')}
      </p>
    </div>
  );
}

function HomePage() {
  const data = Route.useLoaderData() as HomePayload | null;
  const router = useRouter();
  const { t } = useT();

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  /* v8 ignore start — server round-trips covered via deploy smoke. */
  async function handleDismiss(id: number) {
    await dismissReminder({ data: { id } });
    router.invalidate();
  }
  async function handleSnooze(id: number, minutes: number) {
    await snoozeReminder({ data: { id, minutes } });
    router.invalidate();
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        <h1 className="text-base font-semibold text-slate-200 mb-3">{t('nudge.next24h')}</h1>
        {data.upcoming.length === 0 ? (
          <EmptyState />
        ) : (
          <ul className="space-y-2" data-testid="reminders-list">
            {data.upcoming.map((r) => (
              <ReminderRowCard
                key={r.id}
                reminder={r}
                onDismiss={handleDismiss}
                onSnooze={handleSnooze}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
