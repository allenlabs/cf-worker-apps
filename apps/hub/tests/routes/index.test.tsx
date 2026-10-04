import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import { APPS } from '~/lib/apps-catalog';
import { HubBody, HubSummary } from '~/routes/index';
import { HubHeader } from '~/routes/__root';
import { I18nProvider } from '@allenlabs/i18n/react';
import { hubDict } from '~/i18n/dict';

function renderWithRouter(ui: React.ReactElement, path = '/') {
  const rootRoute = createRootRoute({
    component: () => (
      <I18nProvider locale="en" dict={hubDict}>
        <Outlet />
      </I18nProvider>
    ),
  });

  const homeRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <>{ui}</>,
  });

  const healthRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/health',
    component: () => <div />,
  });

  const authLoginRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/auth/login',
    component: () => <div />,
  });

  const authLogoutRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/auth/logout',
    component: () => <div />,
  });

  const routeTree = rootRoute.addChildren([
    homeRoute,
    healthRoute,
    authLoginRoute,
    authLogoutRoute,
  ]);

  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  return render(<RouterProvider router={router as any} />);
}

describe('Hub body', () => {
  it('renders all configured app cards', async () => {
    renderWithRouter(
      <HubBody
        appName="Hub"
        user={{ id: 1, login: 'alice', isAdmin: false }}
        apps={APPS}
      />,
    );
    expect((await screen.findByTestId('hub-summary')).textContent).toMatch(/apps available/);
    for (const app of APPS) {
      expect(await screen.findByTestId(`app-card-${app.slug}`)).toBeTruthy();
      expect((await screen.findByTestId(`app-card-${app.slug}`)).textContent).toContain(app.name);
    }
  });

  it('shows a guest marker when no user is present', async () => {
    renderWithRouter(
      <HubHeader
        appName="Hub"
        currentPath="/"
        user={null}
      />,
    );
    expect((await screen.findByTestId('signed-in-user')).textContent).toBe('Signed in as Guest');
  });
});

describe('HubSummary', () => {
  it('reports the app count', () => {
    render(
      <I18nProvider locale="en" dict={hubDict}>
        <HubSummary count={3} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('hub-summary').textContent).toBe('3 apps available');
  });
});
