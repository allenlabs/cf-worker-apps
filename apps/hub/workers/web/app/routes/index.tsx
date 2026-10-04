import { createFileRoute, useLocation } from '@tanstack/react-router';
import { APPS, type AppEntry } from '~/lib/apps-catalog';
import { Route as RootRoute, HubHeader } from './__root';
import { AppCard } from '~/components/AppCard';
import { useT } from '@allenlabs/i18n/react';

interface HubUser {
  id: number;
  login: string;
  isAdmin: boolean;
}

export interface HubPageProps {
  appName: string;
  user: HubUser | null;
  apps?: ReadonlyArray<AppEntry>;
  locationPathname?: string;
}

export const Route = createFileRoute('/')({
  component: () => {
    const { appName, user } = RootRoute.useLoaderData();
    const location = useLocation();
    return (
      <HomePage
        appName={appName}
        user={user}
        locationPathname={location.pathname}
      />
    );
  },
});

function HomePage({
  appName,
  user,
  apps = APPS,
  locationPathname = '/',
}: HubPageProps) {
  const { t } = useT();
  return (
    <>
      <HubHeader appName={appName} user={user} currentPath={locationPathname} />
      <main className="max-w-6xl mx-auto p-4 md:p-6">
        <h1 className="text-lg md:text-xl font-semibold text-slate-100 mb-3">
          {t('hub.title')}
        </h1>
        <p className="text-sm text-slate-400 mb-6">
          {t('hub.subtitle')}
        </p>
        <HubSummary count={apps.length} />
        <section
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
          aria-label={t('hub.appList')}
        >
          {apps.map((app) => (
            <AppCard key={app.slug} app={app} />
          ))}
        </section>
      </main>
    </>
  );
}

export function HubBody({ appName, user, apps = APPS }: HubPageProps) {
  return <HomePage appName={appName} user={user} apps={apps} />;
}

export function HubSummary({ count }: { count: number }) {
  const { t } = useT();
  return (
    <p className="text-xs text-slate-500" data-testid="hub-summary">
      {t('hub.appsCount', { n: count })}
    </p>
  );
}
