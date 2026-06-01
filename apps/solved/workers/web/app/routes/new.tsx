import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { saveSchema, saveEntryImpl } from '~/server/solved';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const saveEntry = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => saveSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return saveEntryImpl(getDb(), me.id, { ...data, source: data.source ?? 'web' });
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

function NewPage() {
  const router = useRouter();
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* v8 ignore start — exercised by deploy smoke tests. */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedTitle = title.trim();
    const trimmedBody = body.trim();
    if (!trimmedTitle) {
      setError(t('solved.error.titleRequired'));
      return;
    }
    if (!trimmedBody) {
      setError(t('solved.error.bodyRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const created = await saveEntry({
        data: {
          title: trimmedTitle,
          body,
          tags: parseTags(tagsRaw),
          source: 'web',
        },
      });
      router.navigate({ to: '/entry/$id', params: { id: String(created.id) } });
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
        <h1 className="text-lg font-semibold text-slate-200 mb-3">{t('solved.new.title')}</h1>
        <form onSubmit={submit} className="space-y-3" data-testid="new-form">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('solved.new.titlePlaceholder')}
            aria-label={t('solved.new.titleLabel')}
            autoFocus
            className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-solved-500 focus:outline-none"
            data-testid="title-input"
          />
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('solved.new.bodyPlaceholder')}
            aria-label={t('solved.new.bodyLabel')}
            rows={14}
            className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-solved-500 focus:outline-none"
            data-testid="body-input"
          />
          <input
            type="text"
            value={tagsRaw}
            onChange={(e) => setTagsRaw(e.target.value)}
            placeholder={t('solved.new.tagsPlaceholder')}
            aria-label={t('solved.new.tagsLabel')}
            className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-solved-500 focus:outline-none"
            data-testid="tags-input"
          />
          {error ? (
            <p className="text-sm text-red-400" data-testid="form-error">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="submit"
              disabled={submitting || body.trim().length === 0 || title.trim().length === 0}
              className="rounded bg-solved-600 hover:bg-solved-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white"
              data-testid="save-button"
            >
              {submitting ? t('state.saving') : t('btn.save')}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
