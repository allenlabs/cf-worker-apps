import { Link, createFileRoute, getRouteApi } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { getProjectImpl } from '~/server/projects';
import { listWikiPagesImpl } from '~/server/wiki';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadWikiIndex = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    return listWikiPagesImpl(db, project.id);
  });

export const Route = createFileRoute('/projects/$identifier/wiki/')({
  loader: ({ params }) => loadWikiIndex({ data: { identifier: params.identifier } }),
  component: WikiIndex,
});

function WikiIndex() {
  const project = parentRoute.useLoaderData();
  const { pages } = Route.useLoaderData();
  const { t } = useT();
  return (
    <div>
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-semibold">{t('wiki.title')}</h2>
        <Link
          className="btn-primary"
          to="/projects/$identifier/wiki/$slug"
          params={{ identifier: project.identifier, slug: 'index' }}
        >
          {t('wiki.newPage')}
        </Link>
      </header>
      {pages.length === 0 ? (
        <section className="card p-8 text-center">
          <h3 className="text-lg font-semibold mb-2">{t('wiki.emptyTitle')}</h3>
          <p className="text-sm text-gray-600 mb-4">
            {t('wiki.emptyBody')}
          </p>
          <Link
            className="btn-primary"
            to="/projects/$identifier/wiki/$slug"
            params={{ identifier: project.identifier, slug: 'index' }}
          >
            {t('wiki.createIndex')}
          </Link>
        </section>
      ) : (
        <ul className="card divide-y divide-gray-100">
          {pages.map((p) => (
            <li key={p.id} className="p-3">
              <Link
                to="/projects/$identifier/wiki/$slug"
                params={{ identifier: project.identifier, slug: p.slug }}
                className="font-medium"
              >
                {p.title}
              </Link>
              <span className="text-xs text-gray-500 ml-2">/{p.slug}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
