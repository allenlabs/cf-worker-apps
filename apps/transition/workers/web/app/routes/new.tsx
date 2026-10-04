import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { saveRitualImpl, saveRitualSchema, type SaveRitualInput } from '~/server/transition';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { RitualForm } from '~/components/RitualForm';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const saveRitual = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => saveRitualSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return saveRitualImpl(getDb(), me.id, data);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/new')({
  component: NewPage,
});

function NewPage() {
  const router = useRouter();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<number | null>(null);

  /* v8 ignore start */
  async function handleSubmit(input: SaveRitualInput) {
    setError(null);
    setBusy(true);
    try {
      const r = await saveRitual({ data: input });
      setSavedId(r.id);
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
        <h1 className="text-base font-semibold text-slate-200">
          {t('transition.handoffTitle')}
        </h1>
        <p className="text-xs text-slate-500">
          {t('transition.handoffSubtitle')}
        </p>
        {savedId ? (
          <div className="card p-3 border-transition-700 bg-transition-900/30 text-sm" data-testid="saved-banner">
            {t('transition.savedBanner', { id: savedId })}
          </div>
        ) : null}
        <RitualForm onSubmit={handleSubmit} busy={busy} error={error} />
      </div>
    </>
  );
}
