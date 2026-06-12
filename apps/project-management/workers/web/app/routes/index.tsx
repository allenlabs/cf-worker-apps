import { Link, createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { useT } from '@allenlabs/i18n/react';
import { getAdapter, getDb, getEnv } from '~/server/auth-runtime.server';
import { loadHomeImpl } from '~/server/home';
import { timeAgo } from '@allenlabs/pm-core/lib/format';

// Verify the session via the auth adapter, then dispatch to loadHomeImpl which
// does the rest in ONE Hetzner round-trip.  See server/home.ts for the SQL.
const loadHome = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  const req = getRequest();
  const cookie = req?.headers.get('cookie') ?? null;
  const identity = await getAdapter(env).verify(env, cookie);
  if (!identity) return null;
  return loadHomeImpl(getDb(), identity.subject);
});

export const Route = createFileRoute('/')({
  loader: async () => {
    const data = await loadHome();
    return data ?? { projects: [], activities: [] };
  },
  component: HomePage,
});

function HomePage() {
  const { projects, activities } = Route.useLoaderData();
  const { t } = useT();

  if (projects.length === 0) {
    return (
      <section className="card p-10 max-w-2xl mx-auto text-center">
        <h1 className="text-2xl font-semibold mb-3">{t('home.welcomeTitle')}</h1>
        <p className="text-sm text-gray-600 mb-6">
          {t('home.welcomeBody')}
        </p>
        <Link to="/projects/new" className="btn-primary">
          {t('home.createFirstProject')}
        </Link>
      </section>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <section className="lg:col-span-2 card p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">{t('projects.title')}</h2>
          <Link to="/projects/new" className="btn-primary">{t('home.newProject')}</Link>
        </div>
        <ul className="divide-y divide-gray-100">
          {projects.map((p) => (
            <li key={p.id} className="py-2">
              <Link to="/projects/$identifier" params={{ identifier: p.identifier }} className="font-medium">
                {p.name}
              </Link>
              {p.description ? <p className="text-sm text-gray-600 mt-0.5">{p.description}</p> : null}
            </li>
          ))}
        </ul>
      </section>
      <aside className="card p-4">
        <h2 className="text-lg font-semibold mb-3">{t('activity.title')}</h2>
        {activities.length === 0 ? (
          <p className="text-sm text-gray-500">{t('state.nothingYet')}</p>
        ) : (
          <ul className="text-sm space-y-2">
            {activities.map((a) => (
              <li key={a.id}>
                <div>{a.title}</div>
                <div className="text-xs text-gray-500">{timeAgo(a.createdAt)}</div>
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
