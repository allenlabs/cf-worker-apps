import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { timeAgo } from '@allenlabs/pm-core/lib/format';
import { listActivitiesImpl } from '@allenlabs/pm-core/server/activities';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { getProjectImpl } from '~/server/projects';

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadProjectActivity = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    const db = getDb();
    const project = await getProjectImpl(db, me, ctx, data.identifier);
    const activities = await listActivitiesImpl(db, { projectId: project.id, limit: 100 });
    return { activities };
  });

export const Route = createFileRoute('/projects/$identifier/activity')({
  loader: ({ params }) => loadProjectActivity({ data: { identifier: params.identifier } }),
  component: ProjectActivityPage,
});

function ProjectActivityPage() {
  const { activities } = Route.useLoaderData();
  const { t } = useT();
  return (
    <div>
      <h2 className="text-xl font-semibold mb-3">{t('activity.title')}</h2>
      {activities.length === 0 ? (
        <p className="text-sm text-gray-500">{t('activity.empty')}</p>
      ) : (
        <ul className="card divide-y divide-gray-100">
          {activities.map((a) => (
            <li key={a.id} className="p-3">
              <div className="text-sm">{a.title}</div>
              <div className="text-xs text-gray-500">{a.userLogin} · {timeAgo(a.createdAt)}</div>
              {a.body ? <div className="text-xs text-gray-600 mt-1">{a.body}</div> : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
