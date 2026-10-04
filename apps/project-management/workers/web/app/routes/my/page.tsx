import { Link, createFileRoute, redirect } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { useT } from '@allenlabs/i18n/react';
import { PriorityBadge, StatusBadge, TrackerBadge } from '@allenlabs/pm-ui';
import { formatDate, issueKey, timeAgo } from '@allenlabs/pm-core/lib/format';
import { getAdapter, getDb, getEnv } from '~/server/auth-runtime.server';
import { loadMyPageImpl } from '@allenlabs/pm-core/server/home';

// Verify the session via the auth adapter (no DB hit) then dispatch to
// loadMyPageImpl which resolves the user + all four sections in ONE
// Hetzner round-trip.  See server/home.ts for the SQL.
const loadMyPage = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  const req = getRequest();
  const cookie = req?.headers.get('cookie') ?? null;
  const identity = await getAdapter(env).verify(env, cookie);
  if (!identity) return null;
  return loadMyPageImpl(getDb(), identity.subject);
});

export const Route = createFileRoute('/my/page')({
  // No beforeLoad auth check — the loader resolves the user inline as
  // part of its single SQL.  __root.tsx still gates on getCurrentUser
  // for the redirect-when-unauthenticated path; we just don't repeat
  // it here.
  loader: async () => {
    const data = await loadMyPage();
    if (!data) throw redirect({ to: '/auth/login' });
    return data;
  },
  component: MyPagePage,
});

function MyPagePage() {
  const data = Route.useLoaderData();
  const { t } = useT();
  if (!data) return null;
  const { myAssigned, myReported, watched, recent } = data;

  if (
    myAssigned.length === 0 &&
    myReported.length === 0 &&
    watched.length === 0
  ) {
    return (
      <section className="card p-10 max-w-2xl mx-auto text-center">
        <h1 className="text-2xl font-semibold mb-3">{t('my.emptyTitle')}</h1>
        <p className="text-sm text-gray-600 mb-6">
          {t('my.emptyBody')}
        </p>
        <Link to="/projects" className="btn-primary">
          {t('my.browseProjects')}
        </Link>
      </section>
    );
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <section className="lg:col-span-2 space-y-6">
        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-3">{t('my.issuesAssignedToMe')}</h2>
          {myAssigned.length === 0 ? (
            <p className="text-sm text-gray-500">{t('state.none')}</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {myAssigned.map((i) => (
                <li key={i.id} className="py-2 flex items-center gap-2 flex-wrap">
                  <TrackerBadge name={i.trackerName} color={i.trackerColor} />
                  <Link
                    to="/projects/$identifier/issues/$issueId"
                    params={{
                      identifier: i.projectIdentifier,
                      issueId: String(i.id),
                    }}
                    className="font-medium flex-1"
                  >
                    <span className="font-mono text-xs text-gray-500 mr-1">{issueKey(i.projectKey, i.number)}</span>
                    {i.subject}
                  </Link>
                  <StatusBadge name={i.statusName} color={i.statusColor} />
                  <PriorityBadge name={i.priorityName} color={i.priorityColor} />
                  {i.dueDate ? (
                    <span className="text-xs text-gray-500">
                      {t('my.dueShort', { date: formatDate(i.dueDate) })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-3">{t('my.issuesIReported')}</h2>
          {myReported.length === 0 ? (
            <p className="text-sm text-gray-500">{t('state.none')}</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {myReported.map((i) => (
                <li key={i.id} className="py-2 flex items-center gap-2">
                  <Link
                    to="/projects/$identifier/issues/$issueId"
                    params={{
                      identifier: i.projectIdentifier,
                      issueId: String(i.id),
                    }}
                    className="font-medium flex-1"
                  >
                    <span className="font-mono text-xs text-gray-500 mr-1">{issueKey(i.projectKey, i.number)}</span>
                    {i.subject}
                  </Link>
                  <StatusBadge name={i.statusName} color={i.statusColor} />
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card p-4">
          <h2 className="text-lg font-semibold mb-3">{t('my.watched')}</h2>
          {watched.length === 0 ? (
            <p className="text-sm text-gray-500">{t('state.none')}</p>
          ) : (
            <ul className="divide-y divide-gray-100">
              {watched.map((i) => (
                <li key={i.id} className="py-2 flex items-center gap-2">
                  <Link
                    to="/projects/$identifier/issues/$issueId"
                    params={{
                      identifier: i.projectIdentifier,
                      issueId: String(i.id),
                    }}
                    className="font-medium flex-1"
                  >
                    <span className="font-mono text-xs text-gray-500 mr-1">{issueKey(i.projectKey, i.number)}</span>
                    {i.subject}
                  </Link>
                  <StatusBadge name={i.statusName} color={i.statusColor} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <aside className="card p-4">
        <h2 className="text-lg font-semibold mb-3">{t('my.recentActivity')}</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-gray-500">{t('state.nothingYet')}</p>
        ) : (
          <ul className="text-sm space-y-2">
            {recent.map((a) => (
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
