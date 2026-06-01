import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { saveSchema, saveSnippetImpl } from '~/server/stash';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const saveSnippet = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => saveSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return saveSnippetImpl(getDb(), me.id, { ...data, source: data.source ?? 'web' });
  });
/* v8 ignore stop */

export const Route = createFileRoute('/new')({
  component: NewPage,
});

// ---------- pure tag-parser (exported for tests) ----------

/**
 * Parse the comma- or whitespace-separated tags input into a clean array.
 * Drops empty tags, lowercases, dedupes, drops a leading `#` so people can
 * type `#sh, #curl` or `sh curl` interchangeably.
 */
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

// ---------- page ----------

function NewPage() {
  const router = useRouter();
  const { t } = useT();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [language, setLanguage] = useState('');
  const [tagsRaw, setTagsRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* v8 ignore start — exercised by deploy smoke tests. */
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      setError(t('stash.bodyRequired'));
      return;
    }
    setSubmitting(true);
    try {
      const created = await saveSnippet({
        data: {
          title: title.trim() || undefined,
          body,
          language: language.trim() || undefined,
          tags: parseTags(tagsRaw),
          source: 'web',
        },
      });
      router.navigate({ to: '/snippet/$id', params: { id: String(created.id) } });
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
        <h1 className="text-lg font-semibold text-slate-200 mb-3">{t('stash.newTitle')}</h1>
        <form onSubmit={submit} className="space-y-3" data-testid="new-form">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={t('stash.titleOptional')}
            aria-label={t('stash.titleLabel')}
            className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 placeholder:text-slate-500 focus:border-stash-500 focus:outline-none"
            data-testid="title-input"
          />
          <textarea
            autoFocus
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder={t('stash.bodyPrompt')}
            aria-label={t('stash.bodyLabel')}
            rows={14}
            className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-stash-500 focus:outline-none"
            data-testid="body-input"
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <input
              type="text"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              placeholder={t('stash.langPlaceholder')}
              aria-label={t('stash.languageLabel')}
              className="rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-stash-500 focus:outline-none"
              data-testid="lang-input"
            />
            <input
              type="text"
              value={tagsRaw}
              onChange={(e) => setTagsRaw(e.target.value)}
              placeholder={t('stash.tagsSpaceComma')}
              aria-label={t('stash.tagsLabel')}
              className="rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-stash-500 focus:outline-none"
              data-testid="tags-input"
            />
          </div>
          {error ? (
            <p className="text-sm text-red-400" data-testid="form-error">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="submit"
              disabled={submitting || body.trim().length === 0}
              className="rounded bg-stash-600 hover:bg-stash-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold text-white"
              data-testid="save-button"
            >
              {submitting ? t('state.saving') : t('stash.saveShortcut')}
            </button>
          </div>
          <p className="text-xs text-slate-500">
            {t('stash.saveHint')}
          </p>
        </form>
      </div>
    </>
  );
}
