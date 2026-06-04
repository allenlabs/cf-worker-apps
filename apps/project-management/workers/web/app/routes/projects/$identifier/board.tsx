import { Link, createFileRoute, getRouteApi, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { PriorityBadge } from '~/components/badges';
import { groupIssuesByStatus } from '~/lib/board';
import { issueKey } from '~/lib/format';
import { notifyError } from '~/lib/toast';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { listIssuesImpl, updateIssue } from '~/server/issues';
import { getProjectImpl } from '~/server/projects';
import { getRefData } from '~/server/ref-data';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadBoard = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const [issues, refData] = await Promise.all([
      listIssuesImpl(db, { projectId: project.id, statusFilter: 'all', sort: 'priority' }),
      getRefData(db),
    ]);
    const statuses = refData.statuses
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((s) => ({ id: s.id, name: s.name, color: s.color, isClosed: s.isClosed }));
    return { issues, statuses };
  });

export const Route = createFileRoute('/projects/$identifier/board')({
  loader: ({ params }) => loadBoard({ data: { identifier: params.identifier } }),
  component: BoardPage,
});

function BoardPage() {
  const project = parentRoute.useLoaderData();
  const { issues, statuses } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [dragId, setDragId] = useState<number | null>(null);
  const [overStatus, setOverStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const columns = groupIssuesByStatus(issues, statuses);

  async function drop(statusId: number) {
    const id = dragId;
    setDragId(null);
    setOverStatus(null);
    if (id == null) return;
    const issue = issues.find((i) => i.id === id);
    if (!issue || issue.statusId === statusId) return;
    setBusy(true);
    try {
      await updateIssue({ data: { id, notes: '', changes: { statusId } } });
      router.invalidate();
    } catch (err) {
      notifyError(t('issueDetail.updateError', { msg: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2 className="text-xl font-semibold mb-3">{t('board.title')}</h2>
      <div className="flex gap-3 overflow-x-auto pb-2">
        {columns.map((col) => (
          <div
            key={col.id}
            onDragOver={(e) => {
              e.preventDefault();
              setOverStatus(col.id);
            }}
            onDrop={() => drop(col.id)}
            className={`w-64 shrink-0 rounded-lg border ${overStatus === col.id ? 'border-redmine-400 bg-redmine-50' : 'border-gray-200 bg-gray-50'}`}
          >
            <div className="px-3 py-2 text-sm font-semibold flex items-center justify-between border-b border-gray-200">
              <span className={col.isClosed ? 'text-gray-500' : ''}>{col.name}</span>
              <span className="text-xs text-gray-400">{col.issues.length}</span>
            </div>
            <div className="p-2 space-y-2 min-h-[3rem]">
              {col.issues.map((i) => (
                <div
                  key={i.id}
                  draggable={!busy}
                  onDragStart={() => setDragId(i.id)}
                  onDragEnd={() => setDragId(null)}
                  className={`card p-2 text-sm cursor-grab active:cursor-grabbing ${dragId === i.id ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center justify-between gap-1 mb-1">
                    <Link
                      to="/projects/$identifier/issues/$issueId"
                      params={{ identifier: project.identifier, issueId: String(i.id) }}
                      className="font-mono text-xs text-redmine-600"
                    >
                      {issueKey(i.projectKey, i.number)}
                    </Link>
                    <PriorityBadge name={i.priorityName} color={i.priorityColor} />
                  </div>
                  <div className={i.statusIsClosed ? 'line-through text-gray-500' : ''}>{i.subject}</div>
                  {i.assigneeLogin ? (
                    <div className="text-xs text-gray-500 mt-1">{i.assigneeLogin}</div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
