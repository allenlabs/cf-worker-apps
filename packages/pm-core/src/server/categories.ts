import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '../db/client';
import { issueCategories } from '../db/schema';

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
