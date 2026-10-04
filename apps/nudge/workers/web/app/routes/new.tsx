import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { createReminderImpl, createSchema } from '~/server/nudge';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const createReminder = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => createSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return createReminderImpl(getDb(), me.id, { ...data, source: data.source ?? 'web' });
  });
/* v8 ignore stop */

export const Route = createFileRoute('/new')({
  component: NewPage,
});

export function parseTags(raw: string): string[] {
  if (!raw) return [];
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim().replace(/^#/, '').toLowerCase())
    .filter((t) => t.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Parse a human-friendly when expression. Accepts:
 *   - 'now' / 'in 5m' / 'in 2h' / 'in 1d'
 *   - ISO-8601 date strings
 * Returns { relativeSeconds } or { fireAt } or null when ambiguous.
 */
export function parseWhen(raw: string): { relativeSeconds?: number; fireAt?: string } | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  if (v === 'now') return { relativeSeconds: 1 };
  const rel = /^in\s+(\d+)\s*(s|sec|secs|m|min|mins|h|hr|hrs|d|day|days)$/i.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    if (!Number.isFinite(n) || n <= 0) return null;
    const seconds =
      unit.startsWith('s') ? n :
      unit.startsWith('m') ? n * 60 :
      unit.startsWith('h') ? n * 60 * 60 :
      n * 24 * 60 * 60;
    return { relativeSeconds: seconds };
  }
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) return null;
  return { fireAt: d.toISOString() };
}

function NewPage() {
  const router = useRouter();
  const { t } = useT();
  const [text, setText] = useState('');
  const [when, setWhen] = useState('in 30m');
  const [recurrence, setRecurrence] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* v8 ignore start — server round-trip covered via deploy smoke. */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!text.trim()) {
      setError(t('nudge.textRequired'));
      return;
    }
    const parsed = parseWhen(when);
    if (!parsed) {
      setError(t('nudge.whenParseError'));
      return;
    }
    setSubmitting(true);
    try {
      await createReminder({
        data: {
          text: text.trim(),
          ...parsed,
          recurrence: recurrence.trim() || null,
          tags: parseTags(tagsRaw),
          source: 'web',
        },
      });
      router.navigate({ to: '/' });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        <h1 className="text-lg font-semibold text-slate-200 mb-3">{t('nudge.newTitle')}</h1>
        <form onSubmit={submit} className="space-y-3" data-testid="new-form">
          <input
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('nudge.textPrompt')}
            aria-label={t('nudge.textLabel')}
            autoFocus
            className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-nudge-500 focus:outline-none"
            data-testid="text-input"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={when}
              onChange={(e) => setWhen(e.target.value)}
              placeholder={t('nudge.whenPlaceholder')}
              aria-label={t('nudge.whenLabel')}
              className="rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-nudge-500 focus:outline-none"
              data-testid="when-input"
            />
            <input
              type="text"
              value={recurrence}
              onChange={(e) => setRecurrence(e.target.value)}
              placeholder={t('nudge.recurrencePlaceholder')}
              aria-label={t('nudge.recurrenceLabel')}
              className="rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-nudge-500 focus:outline-none"
              data-testid="recurrence-input"
            />
          </div>
          <input
            type="text"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder={t('nudge.tagsPlaceholder')}
            aria-label={t('nudge.tagsLabel')}
            className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-nudge-500 focus:outline-none"
            data-testid="tags-input"
          />
          {error ? (
            <p className="text-sm text-red-400" data-testid="form-error">{error}</p>
          ) : null}
          <div className="flex justify-end">
            <button
              type="submit"
              disabled={submitting || text.trim().length === 0}
              className="rounded bg-nudge-600 hover:bg-nudge-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white"
              data-testid="save-button"
            >
              {submitting ? t('state.saving') : t('nudge.schedule')}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
