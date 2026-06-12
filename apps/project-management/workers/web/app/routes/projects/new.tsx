import { createFileRoute, redirect } from '@tanstack/react-router';
import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { deriveProjectKey, slugify } from '@allenlabs/pm-core/lib/format';
import { notifyError, notifySuccess } from '~/lib/toast';
import { getCurrentUser } from '~/server/auth-runtime.server';
import { createProject } from '~/server/projects';

export const Route = createFileRoute('/projects/new')({
  beforeLoad: async () => {
    // Server-only gate. `getCurrentUser` is a `*.server.*` helper that the
    // vite build replaces with an import-protection mock proxy in the client
    // bundle; `await`ing that mock never settles and would hang client-side
    // navigation to /projects/new. SSR already gated this route, so bail out
    // on the client. (See the long note in routes/__root.tsx.)
    if (typeof document !== 'undefined') return;
    const user = await getCurrentUser();
    if (!user) throw redirect({ to: '/auth/login' });
  },
  component: NewProjectPage,
});

function NewProjectPage() {
  const { t } = useT();
  const [form, setForm] = useState({
    name: '',
    identifier: '',
    key: '',
    description: '',
    homepage: '',
    isPublic: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await createProject({ data: form });
      notifySuccess(t('project.createdToast'));
      // Full-page redirect, NOT router.navigate(). A client-side nav here was
      // also running router.invalidate(), which re-ran the __root loader on the
      // client — and that loader can't read the httpOnly cfr_session JWT, so it
      // returns `user: null`, flipping the header to a signed-out state (looked
      // like a logout). A full load re-runs SSR, which reads the cookie and
      // re-populates the user. Matches the new-issue create flow.
      window.location.href = `/projects/${created.identifier}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      notifyError(t('project.createError', { msg: message }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-2xl card p-6">
      <h1 className="text-xl font-semibold mb-4">{t('project.newTitle')}</h1>
      <form onSubmit={handle} className="space-y-3">
        <div>
          <label className="label">{t('project.name')}</label>
          <input
            data-testid="project-name"
            className="input"
            value={form.name}
            onChange={(e) =>
              setForm({
                ...form,
                name: e.target.value,
                identifier: form.identifier || slugify(e.target.value),
                key: form.key || deriveProjectKey(e.target.value),
              })
            }
            required
          />
        </div>
        <div>
          <label className="label">{t('project.identifier')}</label>
          <input
            data-testid="project-identifier"
            className="input font-mono"
            value={form.identifier}
            onChange={(e) => setForm({ ...form, identifier: e.target.value })}
            required
            pattern="^[a-z0-9][a-z0-9_-]*$"
          />
          <p className="text-xs text-gray-500 mt-1">{t('project.identifierHint')}</p>
        </div>
        <div>
          <label className="label">{t('project.key')}</label>
          <input
            data-testid="project-key"
            className="input font-mono uppercase"
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value.toUpperCase() })}
            maxLength={10}
            pattern="^[A-Za-z][A-Za-z0-9]{0,9}$"
            placeholder="RED"
          />
          <p className="text-xs text-gray-500 mt-1">{t('project.keyHint')}</p>
        </div>
        <div>
          <label className="label">{t('project.description')}</label>
          <textarea
            className="textarea"
            rows={4}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div>
          <label className="label">{t('project.homepage')}</label>
          <input
            className="input"
            value={form.homepage}
            onChange={(e) => setForm({ ...form, homepage: e.target.value })}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={form.isPublic}
            onChange={(e) => setForm({ ...form, isPublic: e.target.checked })}
          />
          {t('project.publicLabel')}
        </label>
        {error ? <p className="text-sm text-red-700">{error}</p> : null}
        <div className="pt-2">
          <button data-testid="project-submit" className="btn-primary" disabled={busy}>
            {busy ? t('btn.creating') : t('btn.create')}
          </button>
        </div>
      </form>
    </div>
  );
}
