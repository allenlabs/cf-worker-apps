// Thin TanStack Start server-fn wrappers. The logic lives in
// @allenlabs/pm-core/server/categories; this file only binds the SSR runtime
// (getDb / requirePermission) — exercised by the wrangler integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  createCategorySchema,
  createCategoryImpl,
  deleteCategoryImpl,
  listCategoriesImpl,
} from '@allenlabs/pm-core/server/categories';
import { getDb, requirePermission } from './auth-runtime.server';

export const listCategories = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => listCategoriesImpl(getDb(), data.projectId));

export const createCategory = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => createCategorySchema.parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_categories');
    return createCategoryImpl(getDb(), data);
  });

export const deleteCategory = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_categories');
    return deleteCategoryImpl(getDb(), data.id);
  });

/* v8 ignore stop */
