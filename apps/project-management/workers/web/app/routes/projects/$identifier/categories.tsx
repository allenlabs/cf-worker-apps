import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { createCategory, deleteCategory, listCategoriesImpl } from '~/server/categories';
import { listMembersImpl } from '~/server/members';
import { getProjectImpl } from '~/server/projects';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadCategories = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const [categories, members] = await Promise.all([
      listCategoriesImpl(db, project.id),
      listMembersImpl(db, project.id),
    ]);
    return { categories, members };
  });

export const Route = createFileRoute('/projects/$identifier/categories')({
  loader: ({ params }) => loadCategories({ data: { identifier: params.identifier } }),
  component: CategoriesPage,
});

function CategoriesPage() {
  const project = parentRoute.useLoaderData();
  const { categories, members } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [name, setName] = useState('');
  const [assignedToId, setAssignedToId] = useState<string>('');

  async function create() {
    if (!name) return;
    await createCategory({
      data: {
        projectId: project.id,
        name,
        assignedToId: assignedToId ? Number(assignedToId) : null,
      },
    });
    setName(''); setAssignedToId('');
    router.invalidate();
  }

  async function remove(id: number) {
    if (!confirm(t('categories.deleteConfirm'))) return;
    await deleteCategory({ data: { id, projectId: project.id } });
    router.invalidate();
  }

  return (
    <div className="space-y-4">
      <header><h2 className="text-xl font-semibold">{t('categories.title')}</h2></header>

      <div className="card p-3 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[12rem]"><label className="label">{t('categories.name')}</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div>
          <label className="label">{t('categories.defaultAssignee')}</label>
          <select className="select" value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>
            <option value="">{t('btn.dash')}</option>
            {members.map((m) => <option key={m.id} value={m.userId}>{m.login}</option>)}
          </select>
        </div>
        <button className="btn-primary" onClick={create}>{t('categories.create')}</button>
      </div>

      {categories.length === 0 ? (
        <p className="text-sm text-gray-500">{t('categories.empty')}</p>
      ) : (
        <table className="data-table card">
          <thead><tr><th>{t('categories.name')}</th><th>{t('categories.defaultAssignee')}</th><th></th></tr></thead>
          <tbody>
            {categories.map((c) => {
              const m = members.find((m) => m.userId === c.assignedToId);
              return (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{m?.login ?? '—'}</td>
                  <td><button className="btn-danger" onClick={() => remove(c.id)}>{t('btn.delete')}</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
