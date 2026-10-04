import { Link, createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { DEFAULT_LOCALE } from '@allenlabs/i18n';

// We used to wrap the router in `routerWithQueryClient` from
// `@tanstack/react-router-with-query`, but that package was pinned at 1.130
// while react-router is 1.170 — a 40-minor drift. The 1.130 wrapper patches
// router internals (SSR dehydrate/hydrate + navigation) that changed by
// 1.170; the mismatch made client-side <Link> navigation synchronously crash
// the renderer (the "click does nothing" report — telemetry showed no request
// fired and the page process died within ~250ms). react-query is not used
// anywhere in this app (zero useQuery/useMutation), so the wrapper + the
// QueryClient were dead weight. Removed; navigation is plain TanStack Router.
export function createRouter() {
  return createTanStackRouter({
    routeTree,
    context: { user: null, locale: DEFAULT_LOCALE },
    defaultPreload: 'intent',
    // Keep SSR from committing a pending component before the loader resolves
    // (that mismatched the hydrated tree → useLoaderData() undefined crash).
    // Confirmed NOT related to the client-nav no-op (tested both ways).
    defaultPendingMs: Number.POSITIVE_INFINITY,
    defaultErrorComponent: ({ error }: { error: unknown }) => (
      <div className="p-6 text-red-700">
        <h2 className="font-semibold">Something went wrong</h2>
        <pre className="mt-2 whitespace-pre-wrap text-xs">{String(error)}</pre>
      </div>
    ),
    defaultNotFoundComponent: () => (
      <div className="max-w-lg mx-auto card p-8 text-center mt-12">
        <h2 className="text-lg font-semibold mb-2">Page not found</h2>
        <p className="text-sm text-gray-600 mb-4">
          The page you’re looking for doesn’t exist or has moved.
        </p>
        <Link to="/projects" className="btn-primary">
          ← Back to projects
        </Link>
      </div>
    ),
  });
}

// TanStack Start 1.168 plugin reads `getRouter` from the router entry file.
export const getRouter = createRouter;

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
