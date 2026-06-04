import { Link, createFileRoute, getRouteApi } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { LabelChip, PriorityBadge, StatusBadge, TrackerBadge } from '~/components/badges';
import { formatDate, issueKey, timeAgo } from '~/lib/format';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { countIssuesImpl, listIssuesImpl } from '~/server/issues';
import { type LabelRow, labelsByIssueImpl, listLabelsImpl } from '~/server/labels';
import { getProjectImpl } from '~/server/projects';
import { getRefData } from '~/server/ref-data';

const parentRoute = getRouteApi('/projects/$identifier');

const SEARCH = {
  status: ['open', 'closed', 'all'] as const,
  assignee: ['any', 'me'] as const,
};

const PAGE_SIZE = 25;

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadIssues = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z
      .object({
        identifier: z.string(),
        statusFilter: z.enum(['open', 'closed', 'all']),
        // 'any' = no assignee filter; 'me' resolves to the current user's
        // local id server-side (the client never learns the numeric id).
        assignee: z.enum(['any', 'me']),
        priority: z.number().optional(),
        version: z.number().optional(),
        category: z.number().optional(),
        label: z.number().optional(),
        q: z.string().optional(),
        sort: z.enum(['updated', 'priority', 'id']),
        page: z.number().int().positive(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const filters = {
      projectId: project.id,
      statusFilter: data.statusFilter,
      assignee: data.assignee === 'me' && me ? me.id : undefined,
      priority: data.priority,
      version: data.version,
      category: data.category,
      label: data.label,
      q: data.q,
      sort: data.sort,
    };
    const [issues, total, refData] = await Promise.all([
      listIssuesImpl(db, { ...filters, limit: PAGE_SIZE, offset: (data.page - 1) * PAGE_SIZE }),
      countIssuesImpl(db, filters),
      getRefData(db),
    ]);
    const [projectLabels, labelMap] = await Promise.all([
      listLabelsImpl(db, project.id),
      labelsByIssueImpl(db, issues.map((i) => i.id)),
    ]);
    // Map isn't serializable across the server-fn boundary — flatten to a record.
    const labelsByIssue: Record<number, LabelRow[]> = {};
    for (const [issueId, ls] of labelMap) labelsByIssue[issueId] = ls;
    const priorities = refData.priorities.map((p) => ({ id: p.id, name: p.name }));
    return { issues, total, page: data.page, pageSize: PAGE_SIZE, projectLabels, labelsByIssue, priorities };
  });

export const Route = createFileRoute('/projects/$identifier/issues/')({
  validateSearch: (s: Record<string, unknown>) => ({
    status: (SEARCH.status as readonly string[]).includes(String(s.status))
      ? (s.status as 'open' | 'closed' | 'all')
      : 'open',
    assignee: (SEARCH.assignee as readonly string[]).includes(String(s.assignee))
      ? (s.assignee as 'any' | 'me')
      : 'any',
    priority: s.priority ? Number(s.priority) : undefined,
    version: s.version ? Number(s.version) : undefined,
    category: s.category ? Number(s.category) : undefined,
    label: s.label ? Number(s.label) : undefined,
    q: s.q ? String(s.q) : undefined,
    sort: s.sort ? (String(s.sort) as 'updated' | 'priority' | 'id') : 'updated',
    page: s.page ? Math.max(1, Number(s.page)) : 1,
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    loadIssues({
      data: {
        identifier: params.identifier,
        statusFilter: deps.status,
        assignee: deps.assignee,
        priority: deps.priority,
        version: deps.version,
        category: deps.category,
        label: deps.label,
        q: deps.q,
        sort: deps.sort,
        page: deps.page,
      },
    }),
  component: IssuesIndexPage,
});

function IssuesIndexPage() {
  const project = parentRoute.useLoaderData();
  const { issues, total, page, pageSize, projectLabels, labelsByIssue, priorities } =
    Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { t } = useT();
  // Any filter change resets to page 1; pagination moves page only.
  const update = (patch: Record<string, unknown>) =>
    navigate({ search: (s) => ({ ...s, ...patch, page: 1 }) });
  const goPage = (p: number) => navigate({ search: (s) => ({ ...s, page: p }) });
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
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
            onChange={(e) => update({ status: e.target.value })}
          >
            <option value="open">{t('issuesList.statusOpen')}</option>
            <option value="closed">{t('issuesList.statusClosed')}</option>
            <option value="all">{t('issuesList.statusAll')}</option>
          </select>
        </div>
        <div>
          <label className="label">{t('issue.assignee')}</label>
          <select
            data-testid="filter-assignee"
            className="select"
            value={search.assignee}
            onChange={(e) => update({ assignee: e.target.value })}
          >
            <option value="any">{t('issuesList.statusAll')}</option>
            <option value="me">{t('issue.assigneeMe')}</option>
          </select>
        </div>
        <div>
          <label className="label">{t('issue.priority')}</label>
          <select
            className="select"
            value={search.priority ?? ''}
            onChange={(e) => update({ priority: e.target.value ? Number(e.target.value) : undefined })}
          >
            <option value="">{t('issuesList.statusAll')}</option>
            {priorities.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {project.versions.length > 0 ? (
          <div>
            <label className="label">{t('issue.version')}</label>
            <select
              className="select"
              value={search.version ?? ''}
              onChange={(e) => update({ version: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">{t('issuesList.statusAll')}</option>
              {project.versions.map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        {project.categories.length > 0 ? (
          <div>
            <label className="label">{t('issue.category')}</label>
            <select
              className="select"
              value={search.category ?? ''}
              onChange={(e) => update({ category: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">{t('issuesList.statusAll')}</option>
              {project.categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        {projectLabels.length > 0 ? (
          <div>
            <label className="label">{t('labels.section')}</label>
            <select
              className="select"
              value={search.label ?? ''}
              onChange={(e) => update({ label: e.target.value ? Number(e.target.value) : undefined })}
            >
              <option value="">{t('issuesList.statusAll')}</option>
              {projectLabels.map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          </div>
        ) : null}
        <div>
          <label className="label">{t('issuesList.sortBy')}</label>
          <select
            className="select"
            value={search.sort}
            onChange={(e) => update({ sort: e.target.value })}
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
            onChange={(e) => update({ q: e.target.value || undefined })}
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
              <tr key={i.id} data-testid={`issue-row-${i.id}`}>
                <td className="font-mono text-xs">{issueKey(i.projectKey, i.number)}</td>
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
                  {labelsByIssue[i.id]?.length ? (
                    <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                      {labelsByIssue[i.id]!.map((l) => (
                        <LabelChip key={l.id} name={l.name} color={l.color} />
                      ))}
                    </span>
                  ) : null}
                </td>
                <td>{i.assigneeLogin ?? '—'}</td>
                <td>{i.dueDate ? formatDate(i.dueDate) : '—'}</td>
                <td className="text-xs text-gray-600">{timeAgo(i.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {total > 0 ? (
        <div className="flex items-center justify-between mt-3 text-sm text-gray-600">
          <span>{t('issuesList.pageInfo', { from: (page - 1) * pageSize + 1, to: (page - 1) * pageSize + issues.length, total })}</span>
          <div className="flex gap-2">
            <button className="btn" disabled={page <= 1} onClick={() => goPage(page - 1)}>
              {t('issuesList.prev')}
            </button>
            <span className="px-2 py-1">{t('issuesList.pageOf', { page, totalPages })}</span>
            <button className="btn" disabled={page >= totalPages} onClick={() => goPage(page + 1)}>
              {t('issuesList.next')}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
