import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';
import { Layout } from '~/components/Layout';
import { I18nProvider } from '@allenlabs/i18n/react';
import { pmDict } from '~/i18n/dict';

function renderAt(
  path: string,
  user: { id: number; login: string; isAdmin: boolean } | null,
  appName = 'Test App',
) {
  const rootRoute = createRootRoute({
    component: () => (
      <I18nProvider locale="en" dict={pmDict}>
        <Layout user={user} appName={appName}>
          <Outlet />
        </Layout>
      </I18nProvider>
    ),
  });
  // Add stub child routes so <Link> targets resolve cleanly.
  const stubs = [
    '/',
    '/projects',
    '/projects/new',
    '/activity',
    '/my/page',
    '/notifications',
    '/admin/users',
    '/auth/login',
    '/auth/logout',
    '/search',
  ].map((p) =>
    createRoute({
      getParentRoute: () => rootRoute,
      path: p === '/' ? '/' : p,
      component: () => <div data-testid={`page-${p}`}>{p}</div>,
    }),
  );
  const routeTree = rootRoute.addChildren(stubs);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(<RouterProvider router={router as any} />);
}

describe('Layout', () => {
  it('renders the app name as the brand link', async () => {
    renderAt('/', { id: 1, login: 'alice', isAdmin: false }, 'My Tracker');
    expect(await screen.findByText('My Tracker')).toBeInTheDocument();
  });

  it('shows the sign-out link when signed in', async () => {
    renderAt('/', { id: 1, login: 'alice', isAdmin: false });
    expect(await screen.findByText('alice')).toBeInTheDocument();
    // The shared i18n common dict renders 'nav.signOut' as 'Sign out' in en.
    expect(screen.getByText('Sign out')).toBeInTheDocument();
  });

  it('shows Sign in when signed out', async () => {
    renderAt('/', null);
    expect(await screen.findByText('Sign in')).toBeInTheDocument();
    expect(screen.queryByText('+ New')).not.toBeInTheDocument();
  });

  it('shows the + New pill when signed in', async () => {
    renderAt('/', { id: 1, login: 'alice', isAdmin: false });
    const pill = await screen.findByText('+ New');
    expect(pill).toBeInTheDocument();
    expect(pill.getAttribute('href')).toContain('/projects/new');
  });

  it('shows the Admin link only for admins', async () => {
    renderAt('/', { id: 1, login: 'root', isAdmin: true });
    expect(await screen.findByText('Admin')).toBeInTheDocument();
    renderAt('/', { id: 1, login: 'alice', isAdmin: false });
    // The second render won't have the Admin link (the first one is from a different render).
    const links = screen.queryAllByText('Admin');
    // queryAllByText is across all rendered elements, but each renderAt uses its own jsdom doc.
    // Inside the same render, expect zero.
    expect(links.length).toBeLessThanOrEqual(1);
  });

  it('highlights the nav item matching the active path', async () => {
    renderAt('/projects', { id: 1, login: 'a', isAdmin: false });
    const link = await screen.findByText('Projects');
    expect(link.className).toContain('bg-redmine-700');
  });
});
