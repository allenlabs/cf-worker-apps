import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useState } from 'react';
import {
  deleteEntryImpl,
  getEntryImpl,
  updateSchema,
  updateEntryImpl,
  type EntrySummary,
} from '~/server/solved';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv, requireUser } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { timeAgo } from '~/lib/format';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';
import { parseTags } from './new';

const IdInput = z.object({ id: z.number().int().positive() });

/* v8 ignore start */
const loadEntry = createServerFn({ method: 'POST' })
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
    return getEntryImpl(db, me.id, data.id);
  });

const UpdateInputSchema = z.object({
  id: z.number().int().positive(),
  patch: updateSchema,
});

const updateEntry = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => UpdateInputSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return updateEntryImpl(getDb(), me.id, data.id, data.patch);
  });

const deleteEntry = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return deleteEntryImpl(getDb(), me.id, data.id);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/entry/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    const data = await loadEntry({ data: { id } });
    return data;
  },
  component: DetailPage,
});

interface DetailHeaderProps {
  entry: EntrySummary;
  now?: number;
}

export function DetailHeader({ entry, now }: DetailHeaderProps) {
  const { t } = useT();
  return (
    <div className="mb-4" data-testid="detail-header">
      <h1 className="text-xl font-semibold text-slate-100">{entry.title}</h1>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
        <span>{t('solved.detail.saved', { when: timeAgo(entry.createdAt, now) })}</span>
        {entry.updatedAt !== entry.createdAt ? (
          <span>{t('solved.detail.edited', { when: timeAgo(entry.updatedAt, now) })}</span>
        ) : null}
        {entry.source ? <span>{t('solved.detail.via', { source: entry.source })}</span> : null}
        {entry.sourceRef ? <span>· <code className="text-solved-300">{entry.sourceRef}</code></span> : null}
        {entry.sourceUrl ? (
          <a href={entry.sourceUrl} target="_blank" rel="noreferrer" className="text-solved-400">
            {t('solved.detail.source')}
          </a>
        ) : null}
      </div>
      {entry.tags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          {entry.tags.map((tag) => (
            <span key={tag} className="text-slate-400" data-testid={`tag-${tag}`}>
              #{tag}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DetailPage() {
  const initial = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [snap, setSnap] = useState<EntrySummary | null>(initial);
  const [editing, setEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(initial?.title ?? '');
  const [draftBody, setDraftBody] = useState(initial?.body ?? '');
  const [draftTags, setDraftTags] = useState((initial?.tags ?? []).join(' '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!snap) {
    return (
      <>
        <Header />
        <div className="max-w-3xl mx-auto p-4 text-slate-400" data-testid="not-found">
          <p>{t('solved.detail.notFound')}</p>
          <Link to="/" className="text-solved-400 hover:underline">{t('solved.detail.back')}</Link>
        </div>
      </>
    );
  }

  /* v8 ignore start — server round-trips exercised via deploy smoke. */
  async function save() {
    setError(null);
    setBusy(true);
    try {
      const updated = await updateEntry({
        data: {
          id: snap!.id,
          patch: {
            title: draftTitle.trim(),
            body: draftBody,
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
    if (!confirm(t('solved.detail.deleteConfirm'))) return;
    setBusy(true);
    void deleteEntry({ data: { id: snap!.id } }).then(() => {
      router.navigate({ to: '/' });
    });
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        <Link to="/" className="text-xs text-solved-400 hover:underline">{t('solved.detail.allEntries')}</Link>
        {editing ? (
          <div className="mt-3 space-y-3" data-testid="edit-form">
            <input
              type="text"
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              aria-label={t('solved.new.titleLabel')}
              className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 text-slate-100 focus:border-solved-500 focus:outline-none"
              data-testid="edit-title"
            />
            <textarea
              value={draftBody}
              onChange={(e) => setDraftBody(e.target.value)}
              aria-label={t('solved.new.bodyLabel')}
              rows={16}
              className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 font-mono text-sm text-slate-100 focus:border-solved-500 focus:outline-none"
              data-testid="edit-body"
            />
            <input
              type="text"
              value={draftTags}
              onChange={(e) => setDraftTags(e.target.value)}
              placeholder={t('solved.detail.tagsPlaceholder')}
              aria-label={t('solved.detail.tagsLabel')}
              className="w-full rounded bg-slate-900 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-solved-500 focus:outline-none"
              data-testid="edit-tags"
            />
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
                disabled={busy || draftBody.trim().length === 0 || draftTitle.trim().length === 0}
                className="rounded bg-solved-600 hover:bg-solved-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-sm font-semibold text-white"
                data-testid="save-edit"
              >
                {busy ? t('state.saving') : t('btn.save')}
              </button>
            </div>
          </div>
        ) : (
          <>
            <DetailHeader entry={snap} />
            <div className="flex justify-end gap-2 mb-3">
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded border border-slate-700 px-3 py-1 text-sm text-slate-300 hover:bg-slate-800"
                data-testid="edit-button"
              >
                {t('btn.edit')}
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
                {t('solved.detail.delete')}
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
