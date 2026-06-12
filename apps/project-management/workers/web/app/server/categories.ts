import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '@allenlabs/pm-core/db/client';
import { issueCategories } from '@allenlabs/pm-core/db/schema';
import { getDb, requirePermission } from './auth-runtime.server';

export async function listCategoriesImpl(db: DB, projectId: number) {
  return db.query.issueCategories.findMany({
    where: eq(issueCategories.projectId, projectId),
    orderBy: issueCategories.name,
  });
}

export const createCategorySchema = z.object({
  projectId: z.number(),
  name: z.string().min(1).max(255),
  assignedToId: z.number().nullable().optional(),
});
export type CreateCategoryInput = z.infer<typeof createCategorySchema>;

export async function createCategoryImpl(db: DB, data: CreateCategoryInput) {
  const [c] = await db
    .insert(issueCategories)
    .values({
      projectId: data.projectId,
      name: data.name,
      assignedToId: data.assignedToId ?? null,
    })
    .returning();
  return c;
}

export async function deleteCategoryImpl(db: DB, id: number) {
  await db.delete(issueCategories).where(eq(issueCategories.id, id));
  return { ok: true };
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
/* v8 ignore start */

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
