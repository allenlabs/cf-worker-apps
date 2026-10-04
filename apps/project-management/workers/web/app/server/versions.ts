// Thin TanStack Start server-fn wrappers. The logic lives in
// @allenlabs/pm-core/server/versions; this file only binds the SSR runtime
// (getDb / requirePermission) — exercised by the wrangler integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  createVersionSchema,
  createVersionImpl,
  deleteVersionImpl,
  listVersionsImpl,
  updateVersionSchema,
  updateVersionImpl,
} from '@allenlabs/pm-core/server/versions';
import { getDb, requirePermission } from './auth-runtime.server';

export const listVersions = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => listVersionsImpl(getDb(), data.projectId));

export const createVersion = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => createVersionSchema.parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_versions');
    return createVersionImpl(getDb(), data);
  });

export const updateVersion = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => updateVersionSchema.parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_versions');
    return updateVersionImpl(getDb(), data);
  });

export const deleteVersion = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_versions');
    return deleteVersionImpl(getDb(), data.id);
  });

/* v8 ignore stop */
