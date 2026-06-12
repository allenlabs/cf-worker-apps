// Thin TanStack Start server-fn wrappers. The logic lives in
// @allenlabs/pm-core/server/projects; this file binds the SSR runtime
// (auth-runtime helpers) and threads the active AuthAdapter's onProjectCreated
// provisioning hook. Exercised by the wrangler integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { slugify } from '@allenlabs/pm-core/lib/format';
import { ForbiddenError } from '@allenlabs/pm-core/lib/permissions';
import type { ProjectCreatedContext } from '@allenlabs/pm-core/server/auth/types';
import {
  createProjectSchema,
  createProjectImpl,
  deleteProjectImpl,
  getProjectImpl,
  listProjectsImpl,
  updateProjectSchema,
  updateProjectImpl,
} from '@allenlabs/pm-core/server/projects';
import {
  buildAuthContext,
  getAdapter,
  getDb,
  getCurrentUser,
  getEnv,
  requirePermission,
  requireUser,
} from './auth-runtime.server';

export const listProjects = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await getCurrentUser();
  const ctx = me ? await buildAuthContext(me.id) : null;
  return listProjectsImpl(getDb(), me, ctx);
});

export const getProject = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    const ctx = me ? await buildAuthContext(me.id) : null;
    return getProjectImpl(getDb(), me, ctx, data.identifier);
  });

export const createProject = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => createProjectSchema.parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    const env = getEnv();
    const adapter = getAdapter(env);
    const provision = adapter.onProjectCreated
      ? (ctx: ProjectCreatedContext) => adapter.onProjectCreated!(env, ctx)
      : undefined;
    return createProjectImpl(getDb(), user, data, provision);
  });

export const updateProject = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => updateProjectSchema.parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.id, 'edit_project');
    return updateProjectImpl(getDb(), data);
  });

export const deleteProject = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.id, 'delete_project').catch(async () => {
      const u = await requireUser();
      if (!u.isAdmin) throw new ForbiddenError();
    });
    return deleteProjectImpl(getDb(), data.id);
  });

export const suggestIdentifier = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ name: z.string() }).parse(d))
  .handler(async ({ data }) => slugify(data.name));

/* v8 ignore stop */
