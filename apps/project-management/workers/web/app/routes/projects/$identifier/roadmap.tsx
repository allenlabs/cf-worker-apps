import { Link, createFileRoute, getRouteApi } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { ProgressBar } from '~/components/badges';
import { formatDate } from '@allenlabs/pm-core/lib/format';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { listIssuesImpl } from '~/server/issues';
import { getProjectImpl } from '~/server/projects';
import { listVersionsImpl } from '@allenlabs/pm-core/server/versions';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadRoadmap = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const [versions, issues] = await Promise.all([
      listVersionsImpl(db, project.id),
      listIssuesImpl(db, { projectId: project.id, statusFilter: 'all', sort: 'id' }),
    ]);
    return { versions, issues };
  });

export const Route = createFileRoute('/projects/$identifier/roadmap')({
  loader: ({ params }) => loadRoadmap({ data: { identifier: params.identifier } }),
  component: RoadmapPage,
});

function RoadmapPage() {
  const project = parentRoute.useLoaderData();
  const { versions, issues } = Route.useLoaderData();
  const { t } = useT();

  if (versions.length === 0) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-3">{t('roadmap.title')}</h2>
        <p className="text-sm text-gray-500">
          {t('roadmap.empty')}
        </p>
        <Link
          className="btn-primary mt-3"
          to="/projects/$identifier/versions"
          params={{ identifier: project.identifier }}
        >
          {t('roadmap.manageVersions')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-semibold">{t('roadmap.title')}</h2>
      {versions.map((v) => {
        const versionIssues = issues.filter((i) => i.fixedVersionId === v.id);
        return (
          <section key={v.id} className="card p-4">
            <header className="flex items-baseline justify-between mb-2">
              <h3 className="text-lg font-semibold">{v.name}</h3>
              <div className="text-xs text-gray-500">
                {t('roadmap.due', { date: v.dueDate ? formatDate(v.dueDate) : '—' })} · {v.status}
              </div>
            </header>
            {v.description ? <p className="text-sm text-gray-600 mb-2">{v.description}</p> : null}
            <ProgressBar value={v.percent} />
            <p className="text-xs text-gray-500 mt-1">
              {t('roadmap.progress', { closed: v.closedIssues, total: v.totalIssues, pct: v.percent })}
            </p>
            {versionIssues.length > 0 ? (
              <ul className="mt-3 text-sm divide-y divide-gray-100">
                {versionIssues.map((i) => (
                  <li key={i.id} className="py-1 flex items-center gap-2">
                    <span className={i.statusIsClosed ? 'line-through text-gray-500' : ''}>
                      #{i.id} {i.subject}
                    </span>
                    <span className="text-xs text-gray-500 ml-auto">{i.statusName}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
