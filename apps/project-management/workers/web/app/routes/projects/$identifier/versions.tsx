import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { ProgressBar } from '~/components/badges';
import { formatDate } from '@allenlabs/pm-core/lib/format';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { getProjectImpl } from '@allenlabs/pm-core/server/projects';
import { createVersion, deleteVersion, updateVersion } from '~/server/versions';
import { listVersionsImpl } from '@allenlabs/pm-core/server/versions';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadVersions = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const versions = await listVersionsImpl(db, project.id);
    return { versions };
  });

export const Route = createFileRoute('/projects/$identifier/versions')({
  loader: ({ params }) => loadVersions({ data: { identifier: params.identifier } }),
  component: VersionsPage,
});

function VersionsPage() {
  const project = parentRoute.useLoaderData();
  const { versions } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [name, setName] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [description, setDescription] = useState('');

  async function create() {
    if (!name) return;
    await createVersion({
      data: { projectId: project.id, name, description, dueDate: dueDate || null },
    });
    setName(''); setDueDate(''); setDescription('');
    router.invalidate();
  }

  async function remove(id: number) {
    if (!confirm(t('versions.deleteConfirm'))) return;
    await deleteVersion({ data: { id, projectId: project.id } });
    router.invalidate();
  }

  async function close(v: typeof versions[number], newStatus: 'open' | 'locked' | 'closed') {
    await updateVersion({
      data: {
        id: v.id,
        projectId: project.id,
        name: v.name,
        description: v.description,
        dueDate: v.dueDate ?? null,
        status: newStatus,
      },
    });
    router.invalidate();
  }

  return (
    <div className="space-y-4">
      <header><h2 className="text-xl font-semibold">{t('versions.title')}</h2></header>

      <div className="card p-3 grid grid-cols-4 gap-3 items-end">
        <div><label className="label">{t('versions.name')}</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label">{t('versions.dueDate')}</label><input className="input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></div>
        <div className="col-span-1"><label className="label">{t('versions.description')}</label><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></div>
        <button className="btn-primary" onClick={create}>{t('versions.create')}</button>
      </div>

      {versions.length === 0 ? (
        <p className="text-sm text-gray-500">{t('versions.empty')}</p>
      ) : (
        <table className="data-table card">
          <thead>
            <tr><th>{t('versions.name')}</th><th>{t('versions.dueDate')}</th><th>{t('versions.colProgress')}</th><th>{t('versions.colStatus')}</th><th></th></tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id}>
                <td className="font-medium">{v.name}</td>
                <td>{v.dueDate ? formatDate(v.dueDate) : '—'}</td>
                <td>
                  <div className="w-48">
                    <ProgressBar value={v.percent} />
                    <div className="text-xs text-gray-500 mt-0.5">
                      {t('versions.progress', { closed: v.closedIssues, total: v.totalIssues, pct: v.percent })}
                    </div>
                  </div>
                </td>
                <td>
                  <select className="select w-28" value={v.status} onChange={(e) => close(v, e.target.value as any)}>
                    <option value="open">{t('versions.statusOpen')}</option>
                    <option value="locked">{t('versions.statusLocked')}</option>
                    <option value="closed">{t('versions.statusClosed')}</option>
                  </select>
                </td>
                <td><button className="btn-danger" onClick={() => remove(v.id)}>{t('btn.delete')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
