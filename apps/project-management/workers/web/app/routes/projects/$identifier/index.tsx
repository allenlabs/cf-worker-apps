
import { Link, createFileRoute, getRouteApi } from '@tanstack/react-router';
import { useT } from '@allenlabs/i18n/react';
import { ProgressBar } from '~/components/badges';
import { Markdown } from '~/components/Markdown';
import { renderMarkdown } from '~/server/markdown';
import { timeAgo } from '~/lib/format';

const parentRoute = getRouteApi('/projects/$identifier');

// Activities for this project come from the parent CTE — see
// server/projects.ts getProjectImpl.  Killing the child loader removes
// one server-fn round-trip on every project page open (was ~1 s extra,
// fetched a global activities scan because projectId was undefined).
export const Route = createFileRoute('/projects/$identifier/')({
  component: ProjectOverview,
});

function ProjectOverview() {
  const project = parentRoute.useLoaderData();
  const { t } = useT();
  const activities = project.activities;
  const html = renderMarkdown(project.description);
  const open = project.counts.openIssues;
  const closed = project.counts.closedIssues;
  const total = open + closed;
  const pct = total === 0 ? 0 : Math.round((closed / total) * 100);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-2 space-y-4">
        <section className="card p-4">
          <h2 className="text-lg font-semibold mb-2">{t('overview.title')}</h2>
          {html ? (
            <Markdown html={html} />
          ) : (
            <p className="text-sm text-gray-500">{t('overview.noDescription')}</p>
          )}
        </section>

        <section className="card p-4">
          <h2 className="text-lg font-semibold mb-2">{t('overview.issueTracking')}</h2>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div>
              <div className="text-2xl font-semibold">{open}</div>
              <div className="text-xs text-gray-500">{t('overview.open')}</div>
            </div>
            <div>
              <div className="text-2xl font-semibold">{closed}</div>
              <div className="text-xs text-gray-500">{t('overview.closed')}</div>
            </div>
            <div>
              <div className="text-2xl font-semibold">{total}</div>
              <div className="text-xs text-gray-500">{t('overview.total')}</div>
            </div>
          </div>
          <div className="mt-3">
            <ProgressBar value={pct} />
            <p className="text-xs text-gray-500 mt-1">{t('overview.pctClosed', { n: pct })}</p>
          </div>
          <div className="mt-3 flex gap-2">
            <Link
              to="/projects/$identifier/issues"
              params={{ identifier: project.identifier }}
              search={{ status: 'open', q: undefined, sort: 'updated' }}
              className="btn"
            >
              {t('overview.viewIssues')}
            </Link>
            <Link
              to="/projects/$identifier/issues/new"
              params={{ identifier: project.identifier }}
              className="btn-primary"
            >
              {t('overview.newIssue')}
            </Link>
          </div>
        </section>

        {project.versions.length > 0 ? (
          <section className="card p-4">
            <h2 className="text-lg font-semibold mb-2">{t('overview.versions')}</h2>
            <ul className="text-sm space-y-1">
              {project.versions.map((v) => (
                <li key={v.id} className="flex items-center justify-between">
                  <span>{v.name}</span>
                  <span className="text-xs text-gray-500">{v.dueDate ?? '—'}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      <aside className="space-y-4">
        <section className="card p-4">
          <h3 className="font-semibold mb-2">{t('overview.trackers')}</h3>
          <div className="flex flex-wrap gap-1">
            {project.trackers.map((t) => (
              <span
                key={t.id}
                className="badge"
                style={{ backgroundColor: t.color, color: 'white' }}
              >
                {t.name}
              </span>
            ))}
          </div>
        </section>
        <section className="card p-4">
          <h3 className="font-semibold mb-2">{t('overview.latestActivity')}</h3>
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
        </section>
      </aside>
    </div>
  );
}
