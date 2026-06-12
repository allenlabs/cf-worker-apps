import { createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { Markdown } from '~/components/Markdown';
import { formatDateTime } from '@allenlabs/pm-core/lib/format';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { renderMarkdown } from '@allenlabs/pm-core/server/markdown';
import { getProjectImpl } from '~/server/projects';
import { deleteWikiPage, saveWikiPage } from '~/server/wiki';
import { getWikiPageImpl } from '@allenlabs/pm-core/server/wiki';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadWikiPage = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z.object({ identifier: z.string(), slug: z.string() }).parse(d),
  )
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    return getWikiPageImpl(db, project.id, data.slug);
  });

export const Route = createFileRoute('/projects/$identifier/wiki/$slug')({
  loader: async ({ params }) => {
    const data = await loadWikiPage({
      data: { identifier: params.identifier, slug: params.slug },
    });
    const html = data.revision ? renderMarkdown(data.revision.text) : '';
    return { data, html };
  },
  component: WikiPagePage,
});

function WikiPagePage() {
  const project = parentRoute.useLoaderData();
  const { data, html } = Route.useLoaderData();
  const params = Route.useParams();
  const router = useRouter();
  const { t } = useT();
  const [editing, setEditing] = useState(!data.page);
  const [title, setTitle] = useState(data.page?.title ?? params.slug);
  const [text, setText] = useState(data.revision?.text ?? '');
  const [comments, setComments] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await saveWikiPage({
        data: { projectId: project.id, slug: params.slug, title, text, comments },
      });
      setEditing(false);
      setComments('');
      router.invalidate();
    } finally { setBusy(false); }
  }

  async function destroy() {
    if (!data.page || !confirm(t('wiki.deleteConfirm'))) return;
    await deleteWikiPage({ data: { id: data.page.id, projectId: project.id } });
    // Refresh /projects/$identifier/wiki so the deleted page disappears.
    router.invalidate();
    router.navigate({ to: '/projects/$identifier/wiki', params: { identifier: project.identifier } });
  }

  if (editing) {
    return (
      <div className="space-y-3">
        <input className="input text-lg font-semibold" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea className="textarea font-mono text-sm" rows={20} value={text} onChange={(e) => setText(e.target.value)} />
        <input className="input" placeholder={t('wiki.revisionCommentPlaceholder')} value={comments} onChange={(e) => setComments(e.target.value)} />
        <div className="flex gap-2">
          <button className="btn-primary" onClick={save} disabled={busy}>{busy ? t('btn.saving') : t('btn.save')}</button>
          {data.page ? <button className="btn" onClick={() => setEditing(false)}>{t('btn.cancel')}</button> : null}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h2 className="text-xl font-semibold">{data.page?.title ?? params.slug}</h2>
        <div className="flex gap-2">
          <button className="btn" onClick={() => setEditing(true)}>{t('btn.edit')}</button>
          {data.page ? <button className="btn-danger" onClick={destroy}>{t('btn.delete')}</button> : null}
        </div>
      </header>
      {html ? <Markdown html={html} /> : <p className="text-sm text-gray-500">{t('wiki.empty')}</p>}
      {data.revisions.length > 0 ? (
        <section className="card p-3">
          <h3 className="font-semibold mb-2">{t('wiki.revisions')}</h3>
          <ul className="text-xs space-y-1">
            {data.revisions.map((r) => (
              <li key={r.id}>
                v{r.version} · {r.authorLogin} · {formatDateTime(r.createdAt)}
                {r.comments ? <> — <em>{r.comments}</em></> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
