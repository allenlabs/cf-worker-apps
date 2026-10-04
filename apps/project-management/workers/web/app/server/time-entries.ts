// Thin TanStack Start server-fn wrappers. The logic lives in
// @allenlabs/pm-core/server/time-entries; this file only binds the SSR runtime
// (getDb / requirePermission / requireUser) — exercised by the wrangler
// integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { timeEntries } from '@allenlabs/pm-core/db/schema';
import {
  createTimeEntrySchema,
  createTimeEntryImpl,
  deleteTimeEntryImpl,
  listActivitiesImpl,
  listTimeEntriesImpl,
} from '@allenlabs/pm-core/server/time-entries';
import { getDb, requirePermission, requireUser } from './auth-runtime.server';

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
