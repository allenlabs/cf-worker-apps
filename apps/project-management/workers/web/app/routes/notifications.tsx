import { Link, createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useT } from '@allenlabs/i18n/react';
import { issueKey, timeAgo } from '@allenlabs/pm-core/lib/format';
import { getCurrentUser, getDb } from '~/server/auth-runtime.server';
import {
  listNotificationsImpl,
  markAllNotificationsRead,
  markNotificationRead,
} from '~/server/notifications';

// Inline server fn — TanStack Start 1.168.9 dispatch bug workaround.
const loadNotifications = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await getCurrentUser();
  if (!me) return null;
  return { notifications: await listNotificationsImpl(getDb(), me.id) };
});

export const Route = createFileRoute('/notifications')({
  loader: async () => {
    const data = await loadNotifications();
    if (!data) throw redirect({ to: '/auth/login' });
    return data;
  },
  component: NotificationsPage,
});

const KIND_KEY: Record<string, string> = {
  assigned: 'notif.assigned',
  mentioned: 'notif.mentioned',
  commented: 'notif.commented',
  updated: 'notif.updated',
};

function NotificationsPage() {
  const { notifications } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();

  async function markAll() {
    await markAllNotificationsRead();
    router.invalidate();
  }

  async function open(id: number) {
    await markNotificationRead({ data: { id } });
    router.invalidate();
  }

  return (
    <div>
      <header className="flex items-center justify-between mb-3">
        <h1 className="text-2xl font-semibold">{t('notifications.title')}</h1>
        {notifications.some((n) => !n.readAt) ? (
          <button className="btn" onClick={markAll}>{t('notifications.markAllRead')}</button>
        ) : null}
      </header>

      {notifications.length === 0 ? (
        <p className="text-sm text-gray-500">{t('notifications.empty')}</p>
      ) : (
        <ul className="card divide-y divide-gray-100">
          {notifications.map((n) => (
            <li
              key={n.id}
              className={`p-3 flex items-center gap-3 ${n.readAt ? '' : 'bg-redmine-50'}`}
            >
              {n.readAt ? null : <span className="w-2 h-2 rounded-full bg-redmine-500 shrink-0" />}
              <div className="flex-1 text-sm">
                <span className="text-xs uppercase tracking-wide text-gray-500 mr-2">
                  {t(KIND_KEY[n.kind] ?? 'notif.updated')}
                </span>
                <Link
                  to="/projects/$identifier/issues/$issueId"
                  params={{ identifier: n.projectIdentifier, issueId: String(n.issueId) }}
                  onClick={() => open(n.id)}
                >
                  <span className="font-mono text-xs mr-1">{issueKey(n.projectKey, n.number)}</span>
                  {n.subject}
                </Link>
                {n.actorLogin ? <span className="text-gray-500"> · {n.actorLogin}</span> : null}
              </div>
              <span className="text-xs text-gray-400">{timeAgo(n.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
