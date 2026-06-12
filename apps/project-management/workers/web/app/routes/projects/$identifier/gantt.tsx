import { createFileRoute, getRouteApi } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { formatDate, issueKey } from '@allenlabs/pm-core/lib/format';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { listIssuesImpl } from '~/server/issues';
import { listPrecedesEdgesImpl } from '~/server/relations';
import { getProjectImpl } from '~/server/projects';

const parentRoute = getRouteApi('/projects/$identifier');

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadGantt = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const issues = await listIssuesImpl(db, {
      projectId: project.id,
      statusFilter: 'all',
      sort: 'id',
    });
    const edges = await listPrecedesEdgesImpl(db, project.id);
    return { issues, edges };
  });

export const Route = createFileRoute('/projects/$identifier/gantt')({
  loader: ({ params }) => loadGantt({ data: { identifier: params.identifier } }),
  component: GanttPage,
});

const DAY = 24 * 60 * 60 * 1000;

function GanttPage() {
  const project = parentRoute.useLoaderData();
  const { issues, edges } = Route.useLoaderData();
  const { t } = useT();

  const dated = issues.filter((i) => i.startDate || i.dueDate);
  if (dated.length === 0) {
    return (
      <div>
        <h2 className="text-xl font-semibold mb-3">{t('gantt.title')}</h2>
        <p className="text-sm text-gray-500">
          {t('gantt.empty')}
        </p>
      </div>
    );
  }

  // Determine date window
  const today = new Date();
  let min = today.getTime();
  let max = today.getTime();
  for (const i of dated) {
    if (i.startDate) min = Math.min(min, new Date(i.startDate).getTime());
    if (i.dueDate) max = Math.max(max, new Date(i.dueDate).getTime());
  }
  // pad
  min -= 3 * DAY;
  max += 3 * DAY;
  const totalDays = Math.max(7, Math.round((max - min) / DAY));
  const dayW = Math.max(18, Math.min(40, Math.floor(900 / totalDays)));
  const width = dayW * totalDays;
  const rowH = 28;
  const headerH = 28;
  const height = headerH + dated.length * rowH;

  // Bar geometry per issue id, reused for both the bars and the dependency
  // arrows (precedes edges) so the two always line up.
  const geom = new Map<number, { x: number; y: number; w: number }>();
  dated.forEach((i, idx) => {
    const s = new Date(i.startDate ?? i.dueDate ?? min).getTime();
    const e = new Date(i.dueDate ?? i.startDate ?? min).getTime();
    const x = Math.round((s - min) / DAY) * dayW;
    const w = Math.max(dayW / 2, Math.round((e - s) / DAY + 1) * dayW);
    geom.set(i.id, { x, y: headerH + idx * rowH + 6, w });
  });
  const barH = rowH - 12;
  // Only edges whose endpoints are both on the chart can be drawn.
  const drawableEdges = edges.filter((e) => geom.has(e.fromIssueId) && geom.has(e.toIssueId));

  const months: Array<{ label: string; offset: number; width: number }> = [];
  let cursor = new Date(min);
  while (cursor.getTime() < max) {
    const monthStart = new Date(cursor.getFullYear(), cursor.getMonth(), 1).getTime();
    const monthEnd = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1).getTime();
    const startOffset = Math.max(0, Math.round((monthStart - min) / DAY)) * dayW;
    const w = Math.min(width - startOffset, Math.round((monthEnd - Math.max(monthStart, min)) / DAY) * dayW);
    if (w > 0) {
      months.push({
        label: cursor.toLocaleDateString(undefined, { year: 'numeric', month: 'short' }),
        offset: startOffset,
        width: w,
      });
    }
    cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
  }

  return (
    <div>
      <h2 className="text-xl font-semibold mb-3">{t('gantt.title')}</h2>
      <div className="card overflow-auto">
        <div className="flex">
          <div className="w-72 shrink-0 border-r border-gray-200">
            <div className="h-7 bg-gray-100 px-2 py-1 text-xs font-semibold uppercase">{t('gantt.colIssue')}</div>
            {dated.map((i) => {
              // Indent issues whose parent is also on the chart (one level).
              const indented = i.parentId != null && geom.has(i.parentId);
              return (
                <div
                  key={i.id}
                  className="h-7 px-2 py-1 text-sm truncate border-b border-gray-100"
                  style={indented ? { paddingLeft: 20 } : undefined}
                >
                  {indented ? <span className="text-gray-300 mr-1">↳</span> : null}
                  <span className="font-mono text-xs text-gray-500 mr-1">{issueKey(i.projectKey, i.number)}</span>{i.subject}
                </div>
              );
            })}
          </div>
          <svg width={width} height={height} className="block">
            {/* month header */}
            {months.map((m, idx) => (
              <g key={idx}>
                <rect x={m.offset} y={0} width={m.width} height={headerH} fill="#f3f4f6" stroke="#e5e7eb" />
                <text x={m.offset + 4} y={18} fontSize="11" fill="#374151">{m.label}</text>
              </g>
            ))}
            {/* row backgrounds */}
            {dated.map((_, idx) => (
              <rect
                key={idx}
                x={0}
                y={headerH + idx * rowH}
                width={width}
                height={rowH}
                fill={idx % 2 === 0 ? '#ffffff' : '#fafafa'}
              />
            ))}
            {/* today marker */}
            {(() => {
              const x = Math.round((today.getTime() - min) / DAY) * dayW;
              return <line x1={x} y1={0} x2={x} y2={height} stroke="#dc2626" strokeWidth={1} />;
            })()}
            {/* bars */}
            {dated.map((i) => {
              const g = geom.get(i.id)!;
              const fillFull = i.statusIsClosed ? '#94a3b8' : '#3a7fa5';
              const doneW = (g.w * (i.doneRatio ?? 0)) / 100;
              return (
                <g key={i.id}>
                  <rect x={g.x} y={g.y} width={g.w} height={barH} rx={3} fill="#e5e7eb" />
                  {doneW > 0 ? <rect x={g.x} y={g.y} width={doneW} height={barH} rx={3} fill={fillFull} /> : null}
                  <rect x={g.x} y={g.y} width={g.w} height={barH} rx={3} fill="none" stroke="#9ca3af" />
                  <text x={g.x + 4} y={g.y + 12} fontSize="10" fill="#1f2937">
                    {i.doneRatio}% · {formatDate(i.dueDate ?? i.startDate)}
                  </text>
                </g>
              );
            })}
            {/* precedes dependency arrows: end of source bar → start of target bar */}
            {drawableEdges.length > 0 ? (
              <defs>
                <marker id="gantt-arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#dc2626" />
                </marker>
              </defs>
            ) : null}
            {drawableEdges.map((e, idx) => {
              const from = geom.get(e.fromIssueId)!;
              const to = geom.get(e.toIssueId)!;
              const x1 = from.x + from.w;
              const y1 = from.y + barH / 2;
              const x2 = to.x;
              const y2 = to.y + barH / 2;
              const midX = Math.max(x1 + 6, (x1 + x2) / 2);
              return (
                <polyline
                  key={`edge-${idx}`}
                  points={`${x1},${y1} ${midX},${y1} ${midX},${y2} ${x2},${y2}`}
                  fill="none"
                  stroke="#dc2626"
                  strokeWidth={1}
                  markerEnd="url(#gantt-arrow)"
                />
              );
            })}
          </svg>
        </div>
      </div>
    </div>
  );
}
