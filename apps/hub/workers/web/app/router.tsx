import { QueryClient } from '@tanstack/react-query';
import { Link, createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { DEFAULT_LOCALE, type Locale } from '@allenlabs/i18n';

type HubUser = {
  id: number;
  login: string;
  isAdmin: boolean;
};

interface RouterContext {
  queryClient: QueryClient;
  user: HubUser | null;
  appName: string;
  locale: Locale;
}

export function createRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false },
    },
  });

  const router = createTanStackRouter({
    routeTree,
    context: {
      queryClient,
      user: null,
      appName: 'Hub',
      locale: DEFAULT_LOCALE,
    },
    defaultPreload: 'intent',
    defaultPendingMs: Number.POSITIVE_INFINITY,
    defaultErrorComponent: ({ error }: { error: unknown }) => (
      <div className="p-6 text-red-300">
        <h2 className="font-semibold">Hub startup error</h2>
        <pre className="mt-2 whitespace-pre-wrap text-xs">{String(error)}</pre>
      </div>
    ),
    defaultNotFoundComponent: () => (
      <div className="max-w-lg mx-auto card p-8 text-center mt-12 text-slate-300">
        <h2 className="text-lg font-semibold mb-2">Page not found</h2>
        <Link to="/" className="text-emerald-400 hover:underline">
          ← Back to hub
        </Link>
      </div>
    ),
  });

  return router;
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}

export const getRouter = createRouter;
