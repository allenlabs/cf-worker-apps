import { Link, Outlet, createFileRoute, notFound } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useT } from '@allenlabs/i18n/react';
import { ProjectSidebar } from '@allenlabs/pm-ui';
import { buildAuthContext, getCurrentUser, getDb } from '~/server/auth-runtime.server';
import { getProjectImpl } from '@allenlabs/pm-core/server/projects';

// Inline server fn — see routes/index.tsx for the bug context (TanStack
// Start 1.168.9 dispatch issue: imported `createServerFn` exports return
// `undefined` when awaited from inside another loader).
const loadProject = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    // Admins don't need the membership scan — skip it.
    const ctx = me && !me.isAdmin ? await buildAuthContext(me.id) : null;
    return getProjectImpl(getDb(), me, ctx, data.identifier);
  });

export const Route = createFileRoute('/projects/$identifier')({
  loader: async ({ params }) => {
    try {
      return await loadProject({ data: { identifier: params.identifier } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not found/i.test(message)) throw notFound();
      throw err;
    }
  },
  notFoundComponent: ProjectNotFound,
  component: ProjectLayout,
});

function ProjectLayout() {
  const project = Route.useLoaderData();
  return (
    <div className="grid grid-cols-[14rem_1fr] gap-6">
      <ProjectSidebar
        identifier={project.identifier}
        projectName={project.name}
        modules={project.modules}
      />
      <div>
        <header className="mb-4">
          <h1 className="text-2xl font-semibold">{project.name}</h1>
          {project.description ? (
            <p className="text-sm text-gray-600 mt-1">{project.description}</p>
          ) : null}
        </header>
        <Outlet />
      </div>
    </div>
  );
}

function ProjectNotFound() {
  const { t } = useT();
  return (
    <div className="max-w-lg mx-auto card p-8 text-center mt-12">
      <h2 className="text-lg font-semibold mb-2">{t('project.notFoundTitle')}</h2>
      <p className="text-sm text-gray-600 mb-4">
        {t('project.notFoundBody')}
      </p>
      <Link to="/projects" className="btn-primary">
        {t('project.backToProjects')}
      </Link>
    </div>
  );
}
