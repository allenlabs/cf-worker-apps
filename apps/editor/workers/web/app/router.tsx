import { Link, createRouter as createTanStackRouter } from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { DEFAULT_LOCALE } from '@allenlabs/i18n';

// Plain TanStack Router (no react-query wrapper) — matches PM's working setup
// after the version-drift bug that broke client-side <Link> navigation.
export function createRouter() {
  return createTanStackRouter({
    routeTree,
    context: { user: null, locale: DEFAULT_LOCALE, theme: 'light' },
    defaultPreload: 'intent',
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
        <Link to="/" className="btn-primary">
          ← Back to documents
        </Link>
      </div>
    ),
  });
}

export const getRouter = createRouter;

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createRouter>;
  }
}
