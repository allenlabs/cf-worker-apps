import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '../db/client';
import { issueStatuses, issues, versions } from '../db/schema';

export interface VersionWithProgress {
  id: number;
  projectId: number;
  name: string;
  description: string;
  dueDate: string | null;
  status: 'open' | 'locked' | 'closed';
  sharing: string;
  wikiPage: string | null;
  createdAt: Date;
  totalIssues: number;
  closedIssues: number;
  percent: number;
}

export async function listVersionsImpl(
  db: DB,
  projectId: number,
): Promise<VersionWithProgress[]> {
  const rows = await db.query.versions.findMany({
    where: eq(versions.projectId, projectId),
    orderBy: versions.dueDate,
  });
  const issueRows = await db
    .select({
      fixedVersionId: issues.fixedVersionId,
      statusIsClosed: issueStatuses.isClosed,
    })
    .from(issues)
    .innerJoin(issueStatuses, eq(issueStatuses.id, issues.statusId))
    .where(eq(issues.projectId, projectId));

  return rows.map((v) => {
    const inVersion = issueRows.filter((r) => r.fixedVersionId === v.id);
    const total = inVersion.length;
    const closed = inVersion.filter((r) => r.statusIsClosed).length;
    const pct = total === 0 ? 0 : Math.round((closed / total) * 100);
    return { ...v, totalIssues: total, closedIssues: closed, percent: pct };
  });
}

export const createVersionSchema = z.object({
  projectId: z.number(),
  name: z.string().min(1).max(255),
  description: z.string().optional().default(''),
  dueDate: z.string().nullable().optional(),
  sharing: z
    .enum(['none', 'descendants', 'hierarchy', 'tree', 'system'])
    .optional()
    .default('none'),
});
export type CreateVersionInput = z.infer<typeof createVersionSchema>;

export async function createVersionImpl(db: DB, data: CreateVersionInput) {
  const [v] = await db
    .insert(versions)
    .values({
      projectId: data.projectId,
      name: data.name,
      description: data.description,
      dueDate: data.dueDate ?? null,
      sharing: data.sharing,
    })
    .returning();
  return v;
}

export const updateVersionSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  name: z.string(),
  description: z.string(),
  dueDate: z.string().nullable(),
  status: z.enum(['open', 'locked', 'closed']),
});
export type UpdateVersionInput = z.infer<typeof updateVersionSchema>;

export async function updateVersionImpl(db: DB, data: UpdateVersionInput) {
  await db
    .update(versions)
    .set({
      name: data.name,
      description: data.description,
      dueDate: data.dueDate,
      status: data.status,
    })
    .where(eq(versions.id, data.id));
  return { ok: true };
}

export async function deleteVersionImpl(db: DB, id: number) {
  await db.delete(versions).where(eq(versions.id, id));
  return { ok: true };
}
