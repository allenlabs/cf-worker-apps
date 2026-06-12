import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { formatDate, formatHours } from '@allenlabs/pm-core/lib/format';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { getProjectImpl } from '@allenlabs/pm-core/server/projects';
import { createTimeEntry, deleteTimeEntry } from '~/server/time-entries';
import {
  listActivitiesImpl,
  listTimeEntriesImpl,
} from '@allenlabs/pm-core/server/time-entries';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadTime = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z
      .object({
        identifier: z.string(),
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const [entries, activities] = await Promise.all([
      listTimeEntriesImpl(db, {
        projectId: project.id,
        from: data.from ?? null,
        to: data.to ?? null,
      }),
      listActivitiesImpl(db),
    ]);
    return { ...entries, activities };
  });

export const Route = createFileRoute('/projects/$identifier/time/')({
  validateSearch: (s: Record<string, unknown>) => ({
    from: s.from ? String(s.from) : undefined,
    to: s.to ? String(s.to) : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    loadTime({
      data: {
        identifier: params.identifier,
        from: deps.from ?? null,
        to: deps.to ?? null,
      },
    }),
  component: TimePage,
});

function TimePage() {
  const project = parentRoute.useLoaderData();
  const { entries, total, activities } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const { t } = useT();

  const [form, setForm] = useState({
    activityId: activities.find((a) => a.isDefault)?.id ?? activities[0]?.id ?? 0,
    hours: '',
    comments: '',
    spentOn: new Date().toISOString().slice(0, 10),
    issueId: '',
  });
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!form.hours || !form.activityId) return;
    setBusy(true);
    try {
      await createTimeEntry({
        data: {
          projectId: project.id,
          activityId: form.activityId,
          hours: Number(form.hours),
          comments: form.comments,
          spentOn: form.spentOn,
          issueId: form.issueId ? Number(form.issueId) : null,
        },
      });
      setForm({ ...form, hours: '', comments: '', issueId: '' });
      router.invalidate();
    } finally { setBusy(false); }
  }

  async function remove(id: number) {
    if (!confirm(t('time.deleteConfirm'))) return;
    await deleteTimeEntry({ data: { id, projectId: project.id } });
    router.invalidate();
  }

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold">{t('time.spentTime')}</h2>
        <div className="text-sm text-gray-600">{t('time.total', { hours: formatHours(total) })}</div>
      </header>

      <div className="card p-3 grid grid-cols-2 gap-3 items-end">
        <div>
          <label className="label">{t('time.from')}</label>
          <input type="date" className="input" value={search.from ?? ''} onChange={(e) => navigate({ search: (s) => ({ ...s, from: e.target.value || undefined }) })} />
        </div>
        <div>
          <label className="label">{t('time.to')}</label>
          <input type="date" className="input" value={search.to ?? ''} onChange={(e) => navigate({ search: (s) => ({ ...s, to: e.target.value || undefined }) })} />
        </div>
      </div>

      <div className="card p-3 grid grid-cols-5 gap-3 items-end">
        <div>
          <label className="label">{t('time.date')}</label>
          <input type="date" className="input" value={form.spentOn} onChange={(e) => setForm({ ...form, spentOn: e.target.value })} />
        </div>
        <div>
          <label className="label">{t('time.hours')}</label>
          <input type="number" step="0.25" min="0.25" className="input" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} />
        </div>
        <div>
          <label className="label">{t('time.activity')}</label>
          <select className="select" value={form.activityId} onChange={(e) => setForm({ ...form, activityId: Number(e.target.value) })}>
            {activities.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">{t('time.issueOptional')}</label>
          <input className="input" value={form.issueId} onChange={(e) => setForm({ ...form, issueId: e.target.value })} placeholder="123" />
        </div>
        <div className="col-span-1">
          <label className="label">{t('time.comment')}</label>
          <input className="input" value={form.comments} onChange={(e) => setForm({ ...form, comments: e.target.value })} />
        </div>
        <button className="btn-primary col-span-1" onClick={add} disabled={busy}>{busy ? t('btn.saving') : t('time.logTime')}</button>
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-gray-500">{t('time.empty')}</p>
      ) : (
        <table className="data-table card">
          <thead><tr><th>{t('time.colDate')}</th><th>{t('time.colUser')}</th><th>{t('time.colHours')}</th><th>{t('time.colActivity')}</th><th>{t('time.colIssue')}</th><th>{t('time.colComment')}</th><th></th></tr></thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <td>{formatDate(e.spentOn)}</td>
                <td>{e.userLogin}</td>
                <td className="text-right tabular-nums">{formatHours(e.hours)}</td>
                <td>{e.activityName}</td>
                <td>{e.issueId ? <span className="font-mono text-xs">#{e.issueId}</span> : '—'}</td>
                <td className="text-gray-600">{e.comments}</td>
                <td><button className="btn-danger" onClick={() => remove(e.id)}>{t('btn.delete')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
