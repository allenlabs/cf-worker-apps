import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { LabelChip } from '~/components/badges';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { createLabel, deleteLabel } from '~/server/labels';
import { listLabelsImpl } from '@allenlabs/pm-labels';
import { getProjectImpl } from '@allenlabs/pm-core/server/projects';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadLabels = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    return { labels: await listLabelsImpl(db, project.id) };
  });

export const Route = createFileRoute('/projects/$identifier/labels')({
  loader: ({ params }) => loadLabels({ data: { identifier: params.identifier } }),
  component: LabelsPage,
});

const PRESET_COLORS = ['#6b7280', '#ef4444', '#f59e0b', '#10b981', '#3b82f6', '#8b5cf6', '#ec4899'];

function LabelsPage() {
  const project = parentRoute.useLoaderData();
  const { labels } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [name, setName] = useState('');
  const [color, setColor] = useState(PRESET_COLORS[0]!);

  async function create() {
    if (!name.trim()) return;
    await createLabel({ data: { projectId: project.id, name: name.trim(), color } });
    setName('');
    router.invalidate();
  }

  async function remove(id: number) {
    if (!confirm(t('labels.deleteConfirm'))) return;
    await deleteLabel({ data: { id, projectId: project.id } });
    router.invalidate();
  }

  return (
    <div className="space-y-4">
      <header><h2 className="text-xl font-semibold">{t('labels.title')}</h2></header>

      <div className="card p-3 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[12rem]">
          <label className="label">{t('labels.name')}</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div>
          <label className="label">{t('labels.color')}</label>
          <div className="flex gap-1">
            {PRESET_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                aria-label={c}
                className={`w-6 h-6 rounded-full border-2 ${color === c ? 'border-gray-800' : 'border-transparent'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>
        <button className="btn-primary" onClick={create}>{t('labels.create')}</button>
      </div>

      {labels.length === 0 ? (
        <p className="text-sm text-gray-500">{t('labels.empty')}</p>
      ) : (
        <table className="data-table card">
          <thead><tr><th>{t('labels.name')}</th><th></th></tr></thead>
          <tbody>
            {labels.map((l) => (
              <tr key={l.id}>
                <td><LabelChip name={l.name} color={l.color} /></td>
                <td><button className="btn-danger" onClick={() => remove(l.id)}>{t('btn.delete')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
