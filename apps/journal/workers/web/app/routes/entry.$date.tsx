import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import {
  checkinSchema,
  getByDateImpl,
  upsertCheckinImpl,
  type EntryRow,
} from '~/server/journal';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { CheckinForm } from '~/components/CheckinForm';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const loadEntry = createServerFn({ method: 'GET' })
  .inputValidator((data: unknown) =>
    z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(data),
  )
  .handler(async ({ data }) => {
    const me = await requireUser();
    return getByDateImpl(getDb(), me.id, data.date);
  });

const saveCheckin = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => checkinSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return upsertCheckinImpl(getDb(), me.id, { ...data, source: data.source ?? 'web' });
  });
/* v8 ignore stop */

export const Route = createFileRoute('/entry/$date')({
  loader: async ({ params }) => {
    const entry = await loadEntry({ data: { date: params.date } });
    return { entry, date: params.date };
  },
  component: EntryPage,
});

function EntryPage() {
  const { entry, date } = Route.useLoaderData() as { entry: EntryRow | null; date: string };
  const router = useRouter();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* v8 ignore start */
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
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-200">{date}</h1>
          <Link to="/history" className="text-xs">{t('journal.backHistory')}</Link>
        </div>
        <CheckinForm
          initial={entry}
          date={date}
          onSubmit={handleSubmit}
          busy={busy}
          error={error}
        />
      </div>
    </>
  );
}
