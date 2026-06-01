import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  deleteReminderImpl,
  dismissReminderImpl,
  listAllImpl,
  snoozeReminderImpl,
  type ReminderRow,
} from '~/server/nudge';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { ReminderRowCard } from '~/components/ReminderRow';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const loadAll = createServerFn({ method: 'GET' })
  .inputValidator((data: unknown) =>
    z.object({ includeDismissed: z.boolean().default(false) }).parse(data ?? {}),
  )
  .handler(async ({ data }) => {
    const me = await requireUser();
    return listAllImpl(getDb(), me.id, { includeDismissed: data.includeDismissed });
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

const deleteReminder = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => z.object({ id: z.number().int().positive() }).parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return deleteReminderImpl(getDb(), me.id, data.id);
  });
/* v8 ignore stop */

const SearchSchema = z.object({ all: z.coerce.boolean().optional() });

export const Route = createFileRoute('/all')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({ all: search.all ?? false }),
  loader: async ({ deps }) => {
    const list = await loadAll({ data: { includeDismissed: deps.all } });
    return { list, includeDismissed: deps.all };
  },
  component: AllPage,
});

function AllPage() {
  const { list, includeDismissed } = Route.useLoaderData() as {
    list: ReminderRow[];
    includeDismissed: boolean;
  };
  const router = useRouter();
  const { t } = useT();

  /* v8 ignore start */
  async function handleDismiss(id: number) {
    await dismissReminder({ data: { id } });
    router.invalidate();
  }
  async function handleSnooze(id: number, minutes: number) {
    await snoozeReminder({ data: { id, minutes } });
    router.invalidate();
  }
  async function handleDelete(id: number) {
    if (!confirm(t('nudge.deleteConfirm'))) return;
    await deleteReminder({ data: { id } });
    router.invalidate();
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-base font-semibold text-slate-200">{t('nudge.all')}</h1>
          <label className="text-xs text-slate-400 flex items-center gap-1">
            <input
              type="checkbox"
              defaultChecked={includeDismissed}
              onChange={(e) => {
                /* v8 ignore start */
                router.navigate({
                  to: '/all',
                  search: { all: e.currentTarget.checked },
                });
                /* v8 ignore stop */
              }}
              data-testid="include-dismissed"
            />
            {t('nudge.includeDismissed')}
          </label>
        </div>
        {list.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="no-reminders">{t('nudge.noReminders')}</p>
        ) : (
          <ul className="space-y-2" data-testid="reminders-list">
            {list.map((r) => (
              <li key={r.id} className="space-y-1">
                <ReminderRowCard reminder={r} onDismiss={handleDismiss} onSnooze={handleSnooze} />
                <div className="text-right">
                  <button
                    type="button"
                    onClick={() => handleDelete(r.id)}
                    className="text-xs text-slate-500 hover:text-red-300 underline"
                    data-testid={`delete-${r.id}`}
                  >
                    {t('nudge.delete')}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
