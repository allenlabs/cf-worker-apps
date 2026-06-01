import { Link, createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { notifyError, notifySuccess } from '~/lib/toast';
import { deleteProject, updateProject } from '~/server/projects';

const parentRoute = getRouteApi('/projects/$identifier');

export const Route = createFileRoute('/projects/$identifier/settings')({
  component: SettingsPage,
});

function SettingsPage() {
  const project = parentRoute.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [form, setForm] = useState({
    name: project.name,
    description: project.description,
    homepage: project.homepage,
    isPublic: project.isPublic,
    status: project.status,
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await updateProject({ data: { id: project.id, ...form } });
      notifySuccess(t('settings.saved'));
      router.invalidate();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setErr(message);
      notifyError(t('settings.saveError', { msg: message }));
    } finally { setBusy(false); }
  }

  async function destroy() {
    if (!confirm(t('settings.deleteConfirm', { name: project.name }))) return;
    try {
      await deleteProject({ data: { id: project.id } });
      notifySuccess(t('settings.deleted'));
      // Invalidate so /projects doesn't surface the just-deleted row.
      router.invalidate();
      router.navigate({ to: '/projects' });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      notifyError(t('settings.deleteError', { msg: message }));
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <form onSubmit={save} className="card p-6 space-y-3">
        <h2 className="text-xl font-semibold">{t('settings.title')}</h2>
        <div><label className="label">{t('project.name')}</label><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required /></div>
        <div><label className="label">{t('project.identifier')}</label><input className="input font-mono" value={project.identifier} disabled /></div>
        <div><label className="label">{t('project.description')}</label><textarea className="textarea" rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></div>
        <div><label className="label">{t('settings.homepage')}</label><input className="input" value={form.homepage} onChange={(e) => setForm({ ...form, homepage: e.target.value })} /></div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} />{t('settings.public')}</label>
        <div><label className="label">{t('settings.status')}</label>
          <select className="select" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value as any })}>
            <option value="active">{t('settings.statusActive')}</option><option value="closed">{t('settings.statusClosed')}</option><option value="archived">{t('settings.statusArchived')}</option>
          </select>
        </div>
        {err ? <p className="text-sm text-red-700">{err}</p> : null}
        <button className="btn-primary" disabled={busy}>{busy ? t('btn.saving') : t('btn.save')}</button>
      </form>

      <div className="card p-6">
        <h3 className="font-semibold">{t('settings.integrations')}</h3>
        <p className="text-sm text-gray-600 my-2">{t('settings.integrationsBody')}</p>
        <Link
          to="/projects/$identifier/settings/integrations"
          params={{ identifier: project.identifier }}
          className="btn-primary inline-block"
        >
          {t('settings.notionSync')}
        </Link>
      </div>

      <div className="card p-6 border-red-200">
        <h3 className="font-semibold text-red-700">{t('settings.dangerZone')}</h3>
        <p className="text-sm text-gray-600 my-2">{t('settings.dangerBody')}</p>
        <button className="btn-danger" onClick={destroy}>{t('settings.deleteProject')}</button>
      </div>
    </div>
  );
}
