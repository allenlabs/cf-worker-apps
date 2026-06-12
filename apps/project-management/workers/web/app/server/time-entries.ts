import { createServerFn } from '@tanstack/react-start';
import { and, desc, eq, gte, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '@allenlabs/pm-core/db/client';
import { issues, timeEntries, timeEntryActivities, users } from '@allenlabs/pm-core/db/schema';
import { logActivityImpl } from './activities';
import { type CurrentUser } from './auth';
import { getDb, requirePermission, requireUser } from './auth-runtime.server';

export async function listActivitiesImpl(db: DB) {
  return db.query.timeEntryActivities.findMany({ orderBy: timeEntryActivities.position });
}

export interface ListTimeEntriesInput {
  projectId: number;
  from?: string | null;
  to?: string | null;
  userId?: number | null;
}

export async function listTimeEntriesImpl(db: DB, opts: ListTimeEntriesInput) {
  const conds = [eq(timeEntries.projectId, opts.projectId)];
  if (opts.from) conds.push(gte(timeEntries.spentOn, opts.from));
  if (opts.to) conds.push(lte(timeEntries.spentOn, opts.to));
  if (opts.userId) conds.push(eq(timeEntries.userId, opts.userId));

  const rows = await db
    .select({
      id: timeEntries.id,
      hours: timeEntries.hours,
      comments: timeEntries.comments,
      spentOn: timeEntries.spentOn,
      createdAt: timeEntries.createdAt,
      userId: timeEntries.userId,
      userLogin: users.login,
      issueId: timeEntries.issueId,
      issueSubject: issues.subject,
      activityId: timeEntries.activityId,
      activityName: timeEntryActivities.name,
    })
    .from(timeEntries)
    .innerJoin(users, eq(users.id, timeEntries.userId))
    .innerJoin(timeEntryActivities, eq(timeEntryActivities.id, timeEntries.activityId))
    .leftJoin(issues, eq(issues.id, timeEntries.issueId))
    .where(and(...conds))
    .orderBy(desc(timeEntries.spentOn), desc(timeEntries.createdAt));

  // `coalesce(sum(...), 0)` always returns exactly one row.
  const totals = await db
    .select({ total: sql<number>`coalesce(sum(${timeEntries.hours}), 0)` })
    .from(timeEntries)
    .where(and(...conds));
  const totalRow = totals[0];
  /* v8 ignore next */
  if (!totalRow) throw new Error('time-entry total query returned no rows');
  return { entries: rows, total: Number(totalRow.total) };
}

export const createTimeEntrySchema = z.object({
  projectId: z.number(),
  issueId: z.number().nullable().optional(),
  activityId: z.number(),
  hours: z.number().positive(),
  comments: z.string().optional().default(''),
  spentOn: z.string(),
});
export type CreateTimeEntryInput = z.infer<typeof createTimeEntrySchema>;

export async function createTimeEntryImpl(
  db: DB,
  user: CurrentUser,
  data: CreateTimeEntryInput,
) {
  const [entry] = await db
    .insert(timeEntries)
    .values({
      projectId: data.projectId,
      issueId: data.issueId ?? null,
      userId: user.id,
      activityId: data.activityId,
      hours: data.hours,
      comments: data.comments,
      spentOn: data.spentOn,
    })
    .returning();
  /* v8 ignore next */
  if (!entry) throw new Error('failed to create time entry');
  await logActivityImpl(db, {
    projectId: data.projectId,
    userId: user.id,
    kind: 'time_logged',
    refId: entry.id,
    title: `${user.login} logged ${data.hours}h${data.issueId ? ` on #${data.issueId}` : ''}`,
    body: data.comments,
  });
  return entry;
}

export async function deleteTimeEntryImpl(
  db: DB,
  id: number,
): Promise<{ ok: true; deleted: boolean }> {
  const entry = await db.query.timeEntries.findFirst({ where: eq(timeEntries.id, id) });
  if (!entry) return { ok: true, deleted: false };
  await db.delete(timeEntries).where(eq(timeEntries.id, id));
  return { ok: true, deleted: true };
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
/* v8 ignore start */

export const listActivities = createServerFn({ method: 'GET' }).handler(async () =>
  listActivitiesImpl(getDb()),
);

export const listTimeEntries = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z
      .object({
        projectId: z.number(),
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
        userId: z.number().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'view_time_entries');
    return listTimeEntriesImpl(getDb(), data);
  });

export const createTimeEntry = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => createTimeEntrySchema.parse(d))
  .handler(async ({ data }) => {
    const { user } = await requirePermission(data.projectId, 'log_time');
    return createTimeEntryImpl(getDb(), user, data);
  });

export const deleteTimeEntry = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    const me = await requireUser();
    const db = getDb();
    const entry = await db.query.timeEntries.findFirst({ where: eq(timeEntries.id, data.id) });
    if (entry && entry.userId !== me.id) {
      await requirePermission(data.projectId, 'edit_time_entries');
    }
    return deleteTimeEntryImpl(db, data.id);
  });

/* v8 ignore stop */
