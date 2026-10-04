import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useState } from 'react';
import {
  deleteSnippetImpl,
  getSnippetImpl,
  updateSchema,
  updateSnippetImpl,
  type SnippetDetail,
} from '~/server/stash';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv, requireUser } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { languageLabel, timeAgo } from '~/lib/format';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';
import { parseTags } from './new';

const IdInput = z.object({ id: z.number().int().positive() });

/* v8 ignore start */
const loadSnippet = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const env = getEnv();
    const cookie = (await import('@tanstack/react-start/server')).getRequest()?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    if (!token) return null;
    const payload = await verifySessionToken(env, token);
    if (!payload?.sub) return null;
    const db = getDb();
    const me = await findUserBySsoImpl(db, payload.sub);
    if (!me) return null;
    return getSnippetImpl(db, me.id, data.id);
  });

const UpdateInputSchema = z.object({
  id: z.number().int().positive(),
  patch: updateSchema,
});

const updateSnippet = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => UpdateInputSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return updateSnippetImpl(getDb(), me.id, data.id, data.patch);
  });

const deleteSnippet = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return deleteSnippetImpl(getDb(), me.id, data.id);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/snippet/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    const data = await loadSnippet({ data: { id } });
    return data;
  },
  component: DetailPage,
});

// ---------- presentational helpers (exported for tests) ----------

interface DetailHeaderProps {
  snippet: SnippetDetail;
  now?: number;
}

export function DetailHeader({ snippet, now }: DetailHeaderProps) {
  const { t } = useT();
  const lang = languageLabel(snippet.language);
  const title = snippet.title || t('stash.untitledSnippet');
  return (
    <div className="mb-4" data-testid="detail-header">
      <h1 className="text-xl font-semibold text-slate-100">{title}</h1>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
        <span>{t('stash.savedAt', { when: timeAgo(snippet.createdAt, now) })}</span>
        {snippet.updatedAt !== snippet.createdAt ? (
          <span>· {t('stash.editedAt', { when: timeAgo(snippet.updatedAt, now) })}</span>
        ) : null}
        {lang ? <span>· <span className="text-stash-300">{lang}</span></span> : null}
        {snippet.source ? <span>· {t('stash.via', { source: snippet.source })}</span> : null}
      </div>
      {snippet.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {snippet.tags.map((t) => (
            <span key={t} className="text-slate-400" data-testid={`tag-${t}`}>
              #{t}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

interface CopyButtonProps {
  text: string;
}

export function CopyButton({ text }: CopyButtonProps) {
  const { t } = useT();
  const [copied, setCopied] = useState(false);
  /* v8 ignore start — covered by deploy smoke; jsdom tests stub clipboard. */
  async function handle() {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      } catch {
        /* Clipboard permission denied — no recovery, button stays idle. */
      }
    }
  }
  /* v8 ignore stop */
  return (
    <button
      type="button"
      onClick={handle}
      className="rounded bg-stash-600 hover:bg-stash-500 px-3 py-1 text-sm font-medium text-white"
      data-testid="copy-button"
    >
      {copied ? t('stash.copied') : t('stash.copy')}
    </button>
  );
}

// ---------- page ----------

function DetailPage() {
  const initial = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [snap, setSnap] = useState<SnippetDetail | null>(initial);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(initial?.title ?? '');
  const [draftBody, setDraftBody] = useState(initial?.body ?? '');
  const [draftLang, setDraftLang] = useState(initial?.language ?? '');
  const [draftTags, setDraftTags] = useState((initial?.tags ?? []).join(' '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!snap) {
    return (
      <>
        <Header />
        <div className="max-w-3xl mx-auto p-4 text-slate-400" data-testid="not-found">
          <p>{t('stash.snippetNotFound')}</p>
          <Link to="/" className="text-stash-400 hover:underline">{t('stash.back')}</Link>
        </div>
      </>
    );
  }

  /* v8 ignore start — server round-trips exercised via deploy smoke. */
  async function save() {
    setError(null);
    setBusy(true);
    try {
      const updated = await updateSnippet({
        data: {
          id: snap!.id,
          patch: {
            title: draftTitle.trim() || null,
            body: draftBody,
            language: draftLang.trim() || null,
            tags: parseTags(draftTags),
          },
        },
      });
      if (updated) {
        setSnap(updated);
        setEditing(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function destroy() {
    if (!confirm(t('stash.deleteConfirm'))) return;
    setBusy(true);
    void deleteSnippet({ data: { id: snap!.id } }).then(() => {
      router.navigate({ to: '/' });
    });
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        <Link to="/" className="text-xs text-stash-400 hover:underline">{t('stash.allSnippets')}</Link>
        {editing ? (
          <div className="mt-3 space-y-3" data-testid="edit-form">
            <input
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder={t('stash.titleOptional')}
              aria-label={t('stash.titleLabel')}
              className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 focus:border-stash-500 focus:outline-none"
              data-testid="edit-title"
            />
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              aria-label={t('stash.bodyLabel')}
              rows={16}
              className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 font-mono text-sm text-slate-100 focus:border-stash-500 focus:outline-none"
              data-testid="edit-body"
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <input
                type="text"
                value={draftLang}
                onChange={(e) => setDraftLang(e.target.value)}
                placeholder={t('stash.languageLabel')}
                aria-label={t('stash.languageLabel')}
                className="rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-stash-500 focus:outline-none"
                data-testid="edit-lang"
              />
              <input
                type="text"
                value={draftTags}
                onChange={(e) => setDraftTags(e.target.value)}
                placeholder={t('stash.tagsLabel')}
                aria-label={t('stash.tagsLabel')}
                className="rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-stash-500 focus:outline-none"
                data-testid="edit-tags"
              />
            </div>
            {error ? <p className="text-sm text-red-400">{error}</p> : null}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="rounded border border-slate-700 px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800"
                data-testid="cancel-edit"
              >
                {t('btn.cancel')}
              </button>
              <button
                type="button"
                onClick={save}
                disabled={busy || draftBody.trim().length === 0}
                className="rounded bg-stash-600 hover:bg-stash-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-sm font-semibold text-white"
                data-testid="save-edit"
              >
                {busy ? t('state.saving') : t('btn.save')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <DetailHeader snippet={snap} />
            <div className="flex justify-end gap-2 mb-3">
              <CopyButton text={snap.body} />
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
                data-testid="edit-button"
              >
                {t('stash.edit')}
              </button>
            </div>
            <pre
              className="card p-3 overflow-x-auto text-sm font-mono whitespace-pre-wrap break-words text-slate-100"
              data-testid="body-view"
            >
              {snap.body}
            </pre>
            <div className="mt-6 text-xs text-slate-500">
              <button
                type="button"
                className="hover:text-red-300 underline"
                data-testid="delete"
                onClick={destroy}
                disabled={busy}
              >
                {t('stash.deleteSnippet')}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
