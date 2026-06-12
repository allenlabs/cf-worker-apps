import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useT } from '@allenlabs/i18n/react';
import { timeAgo } from '@allenlabs/pm-core/lib/format';
import { listActivitiesImpl } from '@allenlabs/pm-core/server/activities';
import { getDb } from '~/server/auth-runtime.server';

// Inline server fn — see routes/index.tsx for the bug context (TanStack
// Start 1.168.9 dispatch issue: an imported `createServerFn` awaited from
// inside a loader returns `undefined`).  Bypass via the *Impl helper.
const loadActivities = createServerFn({ method: 'GET' }).handler(async () => {
  return listActivitiesImpl(getDb(), { limit: 100 });
});

export const Route = createFileRoute('/activity')({
  loader: async () => ({ activities: await loadActivities() }),
  component: ActivityPage,
});

function ActivityPage() {
  const { activities } = Route.useLoaderData();
  const { t } = useT();
  return (
    <div>
      <h1 className="text-2xl font-semibold mb-4">{t('activity.globalTitle')}</h1>
      {activities.length === 0 ? (
        <p className="text-sm text-gray-500">{t('activity.empty')}</p>
      ) : (
        <ul className="card divide-y divide-gray-100">
          {activities.map((a) => (
            <li key={a.id} className="p-3">
              <div className="text-sm">{a.title}</div>
              <div className="text-xs text-gray-500">
                {a.projectName ? <span>{a.projectName} · </span> : null}
                {a.userLogin} · {timeAgo(a.createdAt)}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
