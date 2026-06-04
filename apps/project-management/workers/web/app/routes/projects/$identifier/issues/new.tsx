import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { issueKey } from '~/lib/format';
import { notifyError, notifySuccess } from '~/lib/toast';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { listMembersImpl } from '~/server/members';
import { createIssue } from '~/server/issues';
import { listLabelsImpl } from '~/server/labels';
import { getProjectImpl } from '~/server/projects';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadNewIssueData = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const members = await listMembersImpl(db, project.id);
    const labels = await listLabelsImpl(db, project.id);
    return { members, labels };
  });

export const Route = createFileRoute('/projects/$identifier/issues/new')({
  loader: ({ params }) => loadNewIssueData({ data: { identifier: params.identifier } }),
  component: NewIssuePage,
});

function NewIssuePage() {
  const project = parentRoute.useLoaderData();
  const { members, labels } = Route.useLoaderData();
  const { t } = useT();
  const [form, setForm] = useState({
    trackerId: project.trackers[0]?.id ?? 1,
    subject: '',
    description: '',
    assignedToId: '' as string,
    categoryId: '' as string,
    fixedVersionId: '' as string,
    startDate: '',
    dueDate: '',
    estimatedHours: '',
    doneRatio: 0,
  });
  const [labelIds, setLabelIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  function toggleLabel(id: number) {
    setLabelIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  }

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createIssue({
        data: {
          projectId: project.id,
          trackerId: form.trackerId,
          subject: form.subject,
          description: form.description,
          assignedToId: form.assignedToId ? Number(form.assignedToId) : null,
          categoryId: form.categoryId ? Number(form.categoryId) : null,
          fixedVersionId: form.fixedVersionId ? Number(form.fixedVersionId) : null,
          startDate: form.startDate || null,
          dueDate: form.dueDate || null,
          estimatedHours: form.estimatedHours ? Number(form.estimatedHours) : null,
          doneRatio: Number(form.doneRatio),
          labelIds,
        },
      });
      notifySuccess(t('issueNew.createdToast', { key: issueKey(project.key, created.number) }));
      // Full-page redirect, NOT router.navigate(). Client-side router
      // transitions into a loader-backed route currently hang on this
      // TanStack Start build (same bug worked around with `reloadDocument`
      // on the project Links). The issue *is* created — a client-side nav
      // here left the user on a stuck blank page, so it looked like
      // "New Issue does nothing". A hard nav routes through SSR, which
      // works.
      window.location.href = `/projects/${project.identifier}/issues/${created.id}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      notifyError(t('issueNew.createError', { msg: message }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-6">
      <h2 className="text-xl font-semibold mb-4">{t('issueNew.title')}</h2>
      <form onSubmit={handle} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">{t('issue.tracker')}</label>
            <select
              className="select"
              value={form.trackerId}
              onChange={(e) => setForm({ ...form, trackerId: Number(e.target.value) })}
            >
              {project.trackers.map((t) => (
                <option key={t.id} value={t.id}>{t.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">{t('issue.assignee')}</label>
            <select
              className="select"
              value={form.assignedToId}
              onChange={(e) => setForm({ ...form, assignedToId: e.target.value })}
            >
              <option value="">{t('issueNew.unassigned')}</option>
              {members.map((m) => (
                <option key={m.id} value={m.userId}>{m.login}</option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className="label">{t('issue.subject')}</label>
          <input
            data-testid="issue-subject"
            className="input"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
            required
          />
        </div>
        <div>
          <label className="label">{t('issueNew.descriptionMarkdown')}</label>
          <textarea
            className="textarea font-mono text-sm"
            rows={10}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="label">{t('issue.category')}</label>
            <select
              className="select"
              value={form.categoryId}
              onChange={(e) => setForm({ ...form, categoryId: e.target.value })}
            >
              <option value="">{t('btn.dash')}</option>
              {project.categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">{t('issue.version')}</label>
            <select
              className="select"
              value={form.fixedVersionId}
              onChange={(e) => setForm({ ...form, fixedVersionId: e.target.value })}
            >
              <option value="">{t('btn.dash')}</option>
              {project.versions.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">{t('issue.startDate')}</label>
            <input
              type="date"
              className="input"
              value={form.startDate}
              onChange={(e) => setForm({ ...form, startDate: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t('issue.dueDate')}</label>
            <input
              type="date"
              className="input"
              value={form.dueDate}
              onChange={(e) => setForm({ ...form, dueDate: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t('issue.estimatedHours')}</label>
            <input
              type="number"
              step="0.25"
              min="0"
              className="input"
              value={form.estimatedHours}
              onChange={(e) => setForm({ ...form, estimatedHours: e.target.value })}
            />
          </div>
          <div>
            <label className="label">{t('issue.doneRatio')}</label>
            <input
              type="number"
              min="0"
              max="100"
              step="10"
              className="input"
              value={form.doneRatio}
              onChange={(e) => setForm({ ...form, doneRatio: Number(e.target.value) })}
            />
          </div>
        </div>
        {labels.length > 0 ? (
          <div>
            <label className="label">{t('labels.section')}</label>
            <div className="flex flex-wrap gap-2">
              {labels.map((l) => {
                const on = labelIds.includes(l.id);
                return (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => toggleLabel(l.id)}
                    aria-pressed={on}
                    className={`badge inline-flex items-center gap-1 ${on ? '' : 'opacity-40'}`}
                    style={{ backgroundColor: `${l.color}22`, color: '#1f2937' }}
                  >
                    <span className="inline-block w-2 h-2 rounded-full" style={{ backgroundColor: l.color }} />
                    {l.name}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <div className="pt-2">
          <button data-testid="issue-submit" className="btn-primary" disabled={busy}>
            {busy ? t('btn.creating') : t('btn.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
