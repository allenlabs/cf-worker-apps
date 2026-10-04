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
import { ProjectSidebar } from '../src/ProjectSidebar';
import { I18nProvider } from '@allenlabs/i18n/react';
import { pmUiStrings } from '../src/dict';

function renderAt(path: string, modules: string[]) {
  const root = createRootRoute({
    component: () => (
      <I18nProvider locale="en" dict={pmUiStrings}>
        <div>
          <ProjectSidebar identifier="demo" projectName="Demo" modules={modules} />
          <Outlet />
        </div>
      </I18nProvider>
    ),
  });
  const paths = [
    '/projects/$identifier',
    '/projects/$identifier/activity',
    '/projects/$identifier/issues',
    '/projects/$identifier/board',
    '/projects/$identifier/gantt',
    '/projects/$identifier/roadmap',
    '/projects/$identifier/wiki',
    '/projects/$identifier/files',
    '/projects/$identifier/time',
    '/projects/$identifier/members',
    '/projects/$identifier/versions',
    '/projects/$identifier/categories',
    '/projects/$identifier/labels',
    '/projects/$identifier/settings',
  ];
  const stubs = paths.map((p) =>
    createRoute({
      getParentRoute: () => root,
      path: p === '/projects/$identifier' ? '$identifier' : p.replace('/projects/$identifier/', ''),
      component: () => <div />,
    }),
  );
  const tree = root.addChildren(stubs);
  const router = createRouter({
    routeTree: tree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  return render(<RouterProvider router={router as any} />);
}

describe('ProjectSidebar', () => {
  it('renders the project name as a header', async () => {
    renderAt('/projects/demo', ['issue_tracking', 'wiki', 'files', 'gantt', 'roadmap', 'time_tracking']);
    expect(await screen.findByText('Demo')).toBeInTheDocument();
  });

  it('always shows Overview, Activity, and the Configure section', async () => {
    renderAt('/projects/demo', []);
    expect(await screen.findByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Configure')).toBeInTheDocument();
    expect(screen.getByText('Members')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('hides module-gated items when not enabled', async () => {
    renderAt('/projects/demo', []);
    expect(screen.queryByText('Issues')).toBeNull();
    expect(screen.queryByText('Wiki')).toBeNull();
    expect(screen.queryByText('Files')).toBeNull();
    expect(screen.queryByText('Gantt')).toBeNull();
    expect(screen.queryByText('Roadmap')).toBeNull();
    expect(screen.queryByText('Time')).toBeNull();
  });

  it('shows module-gated items when enabled', async () => {
    renderAt('/projects/demo', ['issue_tracking', 'wiki', 'files', 'gantt', 'roadmap', 'time_tracking']);
    expect(await screen.findByText('Issues')).toBeInTheDocument();
    expect(screen.getByText('Wiki')).toBeInTheDocument();
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('Gantt')).toBeInTheDocument();
    expect(screen.getByText('Roadmap')).toBeInTheDocument();
    expect(screen.getByText('Time')).toBeInTheDocument();
  });

  it('highlights the active item', async () => {
    renderAt('/projects/demo/issues', ['issue_tracking']);
    const el = await screen.findByText('Issues');
    expect(el.className).toContain('bg-redmine-100');
  });
});
