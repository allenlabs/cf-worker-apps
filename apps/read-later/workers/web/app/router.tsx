import { QueryClient } from '@tanstack/react-query';
import { Link, createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routerWithQueryClient } from '@tanstack/react-router-with-query';
import { DEFAULT_LOCALE } from '@allenlabs/i18n';
import { routeTree } from './routeTree.gen';

export function createRouter() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 30_000, refetchOnWindowFocus: false },
    },
  });
  const router = createTanStackRouter({
    routeTree,
    context: { queryClient, user: null, locale: DEFAULT_LOCALE },
    defaultPreload: 'intent',
    defaultPendingMs: Number.POSITIVE_INFINITY,
    defaultErrorComponent: ({ error }: { error: unknown }) => (
      <div className="p-6 text-red-300">
        <h2 className="font-semibold">Something went wrong</h2>
        <pre className="mt-2 whitespace-pre-wrap text-xs">{String(error)}</pre>
      </div>
    ),
    defaultNotFoundComponent: () => (
      <div className="max-w-lg mx-auto card p-8 text-center mt-12 text-slate-300">
        <h2 className="text-lg font-semibold mb-2">Not found</h2>
        <Link to="/" className="text-rl-400 hover:underline">
          ← Back to the queue
        </Link>
      </div>
    ),
  });
  return routerWithQueryClient(router, queryClient);
}

export const getRouter = createRouter;

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
