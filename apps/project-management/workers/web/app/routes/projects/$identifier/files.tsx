import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { formatDateTime } from '@allenlabs/pm-core/lib/format';
import {
  buildAuthContext,
  getCurrentUser,
  getDb,
  requirePermission,
} from '~/server/auth-runtime.server';
import { deleteAttachment, listProjectFilesImpl, uploadAttachment } from '~/server/attachments';
import { getProjectImpl } from '~/server/projects';

const parentRoute = getRouteApi('/projects/$identifier');

const handleUpload = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => {
    if (!(d instanceof FormData)) throw new Error('Expected FormData');
    return d;
  })
  .handler(async ({ data }) => {
    const projectId = Number(data.get('projectId'));
    const description = String(data.get('description') ?? '');
    const file = data.get('file');
    if (!(file instanceof File)) throw new Error('No file provided');
    const { user } = await requirePermission(projectId, 'manage_files');
    await uploadAttachment({
      projectId,
      containerType: 'project',
      containerId: projectId,
      file,
      authorId: user.id,
      description,
    });
    return { ok: true };
  });

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadFiles = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const files = await listProjectFilesImpl(db, project.id);
    return { files };
  });

export const Route = createFileRoute('/projects/$identifier/files')({
  loader: ({ params }) => loadFiles({ data: { identifier: params.identifier } }),
  component: FilesPage,
});

function FilesPage() {
  const project = parentRoute.useLoaderData();
  const { files } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function upload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      const fd = new FormData(e.currentTarget);
      fd.set('projectId', String(project.id));
      await handleUpload({ data: fd });
      e.currentTarget.reset();
      router.invalidate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  }

  async function remove(id: number) {
    if (!confirm(t('files.deleteConfirm'))) return;
    await deleteAttachment({ data: { id, projectId: project.id } });
    router.invalidate();
  }

  return (
    <div className="space-y-4">
      <h2 className="text-xl font-semibold">{t('files.title')}</h2>

      <form onSubmit={upload} className="card p-3 flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[14rem]">
          <label className="label">{t('files.file')}</label>
          <input name="file" type="file" className="input" required />
        </div>
        <div className="flex-1 min-w-[14rem]">
          <label className="label">{t('files.description')}</label>
          <input name="description" className="input" />
        </div>
        <button className="btn-primary" disabled={busy}>{busy ? t('files.uploading') : t('files.upload')}</button>
        {err ? <p className="w-full text-sm text-red-700">{err}</p> : null}
      </form>

      {files.length === 0 ? (
        <p className="text-sm text-gray-500">{t('files.empty')}</p>
      ) : (
        <table className="data-table card">
          <thead><tr><th>{t('files.colName')}</th><th>{t('files.colSize')}</th><th>{t('files.colUploaded')}</th><th></th></tr></thead>
          <tbody>
            {files.map((f) => (
              <tr key={f.id}>
                <td><a href={`/files/${f.id}`}>{f.filename}</a>{f.description ? <span className="text-xs text-gray-500 ml-1">— {f.description}</span> : null}</td>
                <td>{Math.ceil(f.filesize / 1024)} KB</td>
                <td>{formatDateTime(f.createdAt)}</td>
                <td><button className="btn-danger" onClick={() => remove(f.id)}>{t('btn.delete')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
