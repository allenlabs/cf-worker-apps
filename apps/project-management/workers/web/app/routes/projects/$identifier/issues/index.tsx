import { Link, createFileRoute, getRouteApi } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { PriorityBadge, StatusBadge, TrackerBadge } from '~/components/badges';
import { formatDate, timeAgo } from '~/lib/format';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { listIssuesImpl } from '~/server/issues';
import { getProjectImpl } from '~/server/projects';

const parentRoute = getRouteApi('/projects/$identifier');

const SEARCH = {
  status: ['open', 'closed', 'all'] as const,
};

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadIssues = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z
      .object({
        identifier: z.string(),
        statusFilter: z.enum(['open', 'closed', 'all']),
        q: z.string().optional(),
        sort: z.enum(['updated', 'priority', 'id']),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const issues = await listIssuesImpl(db, {
      projectId: project.id,
      statusFilter: data.statusFilter,
      q: data.q,
      sort: data.sort,
    });
    return { issues };
  });

export const Route = createFileRoute('/projects/$identifier/issues/')({
  validateSearch: (s: Record<string, unknown>) => ({
    status: (SEARCH.status as readonly string[]).includes(String(s.status))
      ? (s.status as 'open' | 'closed' | 'all')
      : 'open',
    q: s.q ? String(s.q) : undefined,
    sort: s.sort ? (String(s.sort) as 'updated' | 'priority' | 'id') : 'updated',
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    loadIssues({
      data: {
        identifier: params.identifier,
        statusFilter: deps.status,
        q: deps.q,
        sort: deps.sort,
      },
    }),
  component: IssuesIndexPage,
});

function IssuesIndexPage() {
  const project = parentRoute.useLoaderData();
  const { issues } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { t } = useT();
  return (
    <div>
      <header className="flex items-center justify-between mb-3">
        <h2 className="text-xl font-semibold">{t('issues.title')}</h2>
        <Link
          to="/projects/$identifier/issues/new"
          params={{ identifier: project.identifier }}
          className="btn-primary"
        >
          {t('issuesList.newIssue')}
        </Link>
      </header>

      <div className="card p-3 mb-3 flex flex-wrap items-end gap-3">
        <div>
          <label className="label">{t('issue.status')}</label>
          <select
            className="select"
            value={search.status}
            onChange={(e) => navigate({ search: (s) => ({ ...s, status: e.target.value as any }) })}
          >
            <option value="open">{t('issuesList.statusOpen')}</option>
            <option value="closed">{t('issuesList.statusClosed')}</option>
            <option value="all">{t('issuesList.statusAll')}</option>
          </select>
        </div>
        <div>
          <label className="label">{t('issuesList.sortBy')}</label>
          <select
            className="select"
            value={search.sort}
            onChange={(e) => navigate({ search: (s) => ({ ...s, sort: e.target.value as any }) })}
          >
            <option value="updated">{t('issuesList.sortUpdated')}</option>
            <option value="priority">{t('issuesList.sortPriority')}</option>
            <option value="id">{t('issuesList.sortNumber')}</option>
          </select>
        </div>
        <div className="flex-1 min-w-[12rem]">
          <label className="label">{t('filter.query')}</label>
          <input
            className="input"
            value={search.q ?? ''}
            onChange={(e) => navigate({ search: (s) => ({ ...s, q: e.target.value || undefined }) })}
            placeholder={t('issuesList.searchPlaceholder')}
          />
        </div>
      </div>

      {issues.length === 0 ? (
        search.status === 'open' && !search.q ? (
          <section className="card p-8 text-center">
            <h3 className="text-lg font-semibold mb-2">{t('issuesList.emptyTitle')}</h3>
            <p className="text-sm text-gray-600 mb-4">
              {t('issuesList.emptyBody')}
            </p>
            <Link
              to="/projects/$identifier/issues/new"
              params={{ identifier: project.identifier }}
              className="btn-primary"
            >
              {t('issuesList.newIssue')}
            </Link>
          </section>
        ) : (
          <p className="text-sm text-gray-500">{t('issuesList.noMatch')}</p>
        )
      ) : (
        <table className="data-table card">
          <thead>
            <tr>
              <th>#</th>
              <th>{t('issuesList.colTracker')}</th>
              <th>{t('issuesList.colStatus')}</th>
              <th>{t('issuesList.colPriority')}</th>
              <th>{t('issuesList.colSubject')}</th>
              <th>{t('issuesList.colAssignee')}</th>
              <th>{t('issuesList.colDue')}</th>
              <th>{t('issuesList.colUpdated')}</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((i) => (
              <tr key={i.id}>
                <td className="font-mono text-xs">#{i.id}</td>
                <td><TrackerBadge name={i.trackerName} color={i.trackerColor} /></td>
                <td><StatusBadge name={i.statusName} color={i.statusColor} closed={i.statusIsClosed} /></td>
                <td><PriorityBadge name={i.priorityName} color={i.priorityColor} /></td>
                <td>
                  <Link
                    to="/projects/$identifier/issues/$issueId"
                    params={{ identifier: project.identifier, issueId: String(i.id) }}
                  >
                    {i.subject}
                  </Link>
                </td>
                <td>{i.assigneeLogin ?? '—'}</td>
                <td>{i.dueDate ? formatDate(i.dueDate) : '—'}</td>
                <td className="text-xs text-gray-600">{timeAgo(i.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
