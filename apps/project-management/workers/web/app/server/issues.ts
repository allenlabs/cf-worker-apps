import { createServerFn } from '@tanstack/react-start';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import {
  issueCategories,
  issuePriorities,
  issueStatuses,
  issues,
  journalDetails,
  journals,
  projects,
  trackers,
  users,
  versions,
  watchers,
} from '~/db/schema';
import { ForbiddenError } from '~/lib/permissions';
import { logActivityImpl } from './activities';
import { listIssueLabelsImpl, setIssueLabelsImpl } from './labels';
import { dispatchIssueNotificationsImpl } from './notifications';
import { listRelationsImpl } from './relations';
import { type CurrentUser } from './auth';
import { buildAuthContext, getDb, getCurrentUser, getEnv, requirePermission, requireUser } from './auth-runtime.server';
import * as notionGateway from './notion-gateway-client';
import { getRefData } from './ref-data';

const ISSUE_FIELDS = {
  trackerId: 'tracker',
  statusId: 'status',
  priorityId: 'priority',
  assignedToId: 'assigned_to',
  categoryId: 'category',
  fixedVersionId: 'fixed_version',
  parentId: 'parent',
  subject: 'subject',
  description: 'description',
  startDate: 'start_date',
  dueDate: 'due_date',
  estimatedHours: 'estimated_hours',
  doneRatio: 'done_ratio',
  isPrivate: 'is_private',
} as const;

export interface IssueRow {
  id: number;
  number: number;
  projectKey: string;
  subject: string;
  trackerId: number;
  trackerName: string;
  trackerColor: string;
  statusId: number;
  statusName: string;
  statusColor: string;
  statusIsClosed: boolean;
  priorityId: number;
  priorityName: string;
  priorityColor: string;
  assigneeId: number | null;
  assigneeLogin: string | null;
  authorLogin: string;
  doneRatio: number;
  startDate: string | null;
  dueDate: string | null;
  fixedVersionId: number | null;
  updatedAt: Date;
}

export interface ListIssuesInput {
  projectId: number;
  statusFilter?: 'open' | 'closed' | 'all';
  assignee?: number;
  tracker?: number;
  priority?: number;
  version?: number;
  category?: number;
  label?: number;
  sort?: 'updated' | 'priority' | 'id';
  q?: string;
  limit?: number;
  offset?: number;
}

export const listIssuesSchema = z.object({
  projectId: z.number(),
  statusFilter: z.enum(['open', 'closed', 'all']).optional().default('open'),
  assignee: z.number().optional(),
  tracker: z.number().optional(),
  priority: z.number().optional(),
  version: z.number().optional(),
  category: z.number().optional(),
  label: z.number().optional(),
  sort: z.enum(['updated', 'priority', 'id']).optional().default('updated'),
  q: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

// Shared WHERE builder so the row query and the count stay in lock-step.
function issueConditions(data: ListIssuesInput) {
  const statusFilter = data.statusFilter ?? 'open';
  const conditions = [eq(issues.projectId, data.projectId)];
  if (statusFilter === 'open') conditions.push(eq(issueStatuses.isClosed, false));
  else if (statusFilter === 'closed') conditions.push(eq(issueStatuses.isClosed, true));
  if (data.assignee !== undefined) conditions.push(eq(issues.assignedToId, data.assignee));
  if (data.tracker !== undefined) conditions.push(eq(issues.trackerId, data.tracker));
  if (data.priority !== undefined) conditions.push(eq(issues.priorityId, data.priority));
  if (data.version !== undefined) conditions.push(eq(issues.fixedVersionId, data.version));
  if (data.category !== undefined) conditions.push(eq(issues.categoryId, data.category));
  if (data.label !== undefined) {
    conditions.push(
      sql`EXISTS (SELECT 1 FROM pm.issue_labels il WHERE il.issue_id = ${issues.id} AND il.label_id = ${data.label})`,
    );
  }
  if (data.q) {
    const pattern = `%${data.q}%`;
    conditions.push(
      sql`(${issues.subject} LIKE ${pattern} OR ${issues.description} LIKE ${pattern})`,
    );
  }
  return conditions;
}

/** Total issues matching the same filters as listIssuesImpl (for pagination). */
export async function countIssuesImpl(db: DB, data: ListIssuesInput): Promise<number> {
  // count(*) always returns exactly one row, so the destructure is total.
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(issues)
    .innerJoin(issueStatuses, eq(issueStatuses.id, issues.statusId))
    .where(and(...issueConditions(data)));
  return row!.n;
}

export async function listIssuesImpl(db: DB, data: ListIssuesInput): Promise<IssueRow[]> {
  const sort = data.sort ?? 'updated';
  const conditions = issueConditions(data);
  const orderClause =
    sort === 'priority'
      ? desc(issuePriorities.position)
      : sort === 'id'
        ? desc(issues.id)
        : desc(issues.updatedAt);

  const rows = await db
    .select({
      id: issues.id,
      number: issues.number,
      projectKey: projects.key,
      subject: issues.subject,
      trackerId: issues.trackerId,
      trackerName: trackers.name,
      trackerColor: trackers.color,
      statusId: issues.statusId,
      statusName: issueStatuses.name,
      statusColor: issueStatuses.color,
      statusIsClosed: issueStatuses.isClosed,
      priorityId: issues.priorityId,
      priorityName: issuePriorities.name,
      priorityColor: issuePriorities.color,
      assigneeId: issues.assignedToId,
      assigneeLogin: sql<string>`u_assignee.login`,
      authorLogin: users.login,
      doneRatio: issues.doneRatio,
      startDate: issues.startDate,
      dueDate: issues.dueDate,
      // Roadmap groups issues by fixed_version; previously it had no way
      // to filter rows since listIssues didn't return this column.
      fixedVersionId: issues.fixedVersionId,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .innerJoin(trackers, eq(trackers.id, issues.trackerId))
    .innerJoin(issueStatuses, eq(issueStatuses.id, issues.statusId))
    .innerJoin(issuePriorities, eq(issuePriorities.id, issues.priorityId))
    .innerJoin(users, eq(users.id, issues.authorId))
    .leftJoin(sql`users AS u_assignee`, sql`u_assignee.id = ${issues.assignedToId}`)
    .where(and(...conditions))
    .orderBy(orderClause)
    // Paginated callers pass limit/offset; unpaged callers (gantt) get a high
    // ceiling instead of the old hard 200 cap.
    .limit(data.limit ?? 1000)
    .offset(data.offset ?? 0);

  return rows as IssueRow[];
}

export async function getIssueImpl(db: DB, id: number) {
  const issue = await db.query.issues.findFirst({ where: eq(issues.id, id) });
  if (!issue) throw new Error('Issue not found');

  // tracker / status / priority resolve from the module-level cache —
  // they're global ref-data and won't change across the request's life.
  const refData = await getRefData(db);
  const tracker = refData.trackers.find((t) => t.id === issue.trackerId);
  const status = refData.statuses.find((s) => s.id === issue.statusId);
  const priority = refData.priorities.find((p) => p.id === issue.priorityId);

  const [
    project,
    author,
    assignee,
    category,
    version,
    parent,
    children,
    journalRows,
    watcherRows,
    labelRows,
    relationRows,
  ] = await Promise.all([
    db.query.projects.findFirst({ where: eq(projects.id, issue.projectId) }),
    db.query.users.findFirst({ where: eq(users.id, issue.authorId) }),
    issue.assignedToId
      ? db.query.users.findFirst({ where: eq(users.id, issue.assignedToId) })
      : null,
    issue.categoryId
      ? db.query.issueCategories.findFirst({ where: eq(issueCategories.id, issue.categoryId) })
      : null,
    issue.fixedVersionId
      ? db.query.versions.findFirst({ where: eq(versions.id, issue.fixedVersionId) })
      : null,
    issue.parentId ? db.query.issues.findFirst({ where: eq(issues.id, issue.parentId) }) : null,
    db
      .select({
        id: issues.id,
        subject: issues.subject,
        doneRatio: issues.doneRatio,
        statusName: issueStatuses.name,
        statusIsClosed: issueStatuses.isClosed,
      })
      .from(issues)
      .innerJoin(issueStatuses, eq(issueStatuses.id, issues.statusId))
      .where(eq(issues.parentId, issue.id)),
    db
      .select({
        id: journals.id,
        notes: journals.notes,
        createdAt: journals.createdAt,
        userId: journals.userId,
        userLogin: users.login,
      })
      .from(journals)
      .innerJoin(users, eq(users.id, journals.userId))
      .where(eq(journals.issueId, issue.id))
      .orderBy(journals.createdAt),
    db.select({ userId: watchers.userId }).from(watchers).where(eq(watchers.issueId, issue.id)),
    listIssueLabelsImpl(db, issue.id),
    listRelationsImpl(db, issue.id),
  ]);

  const journalIds = journalRows.map((j) => j.id);
  const details = journalIds.length
    ? await db.select().from(journalDetails).where(inArray(journalDetails.journalId, journalIds))
    : [];
  const detailsByJournal = new Map<number, typeof details>();
  for (const d of details) {
    const list = detailsByJournal.get(d.journalId) ?? [];
    list.push(d);
    detailsByJournal.set(d.journalId, list);
  }

  return {
    issue,
    project,
    tracker,
    status,
    priority,
    author,
    assignee,
    category,
    version,
    parent,
    children,
    journals: journalRows.map((j) => ({ ...j, details: detailsByJournal.get(j.id) ?? [] })),
    watchers: watcherRows.map((w) => w.userId),
    labels: labelRows,
    relations: relationRows,
  };
}

export const createIssueSchema = z.object({
  projectId: z.number(),
  trackerId: z.number(),
  subject: z.string().min(1).max(255),
  description: z.string().optional().default(''),
  statusId: z.number().optional(),
  priorityId: z.number().optional(),
  assignedToId: z.number().nullable().optional(),
  categoryId: z.number().nullable().optional(),
  fixedVersionId: z.number().nullable().optional(),
  parentId: z.number().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  estimatedHours: z.number().nullable().optional(),
  doneRatio: z.number().int().min(0).max(100).optional().default(0),
  labelIds: z.array(z.number()).optional(),
});
export type CreateIssueInput = z.infer<typeof createIssueSchema>;

export async function createIssueImpl(
  db: DB,
  user: CurrentUser,
  data: CreateIssueInput,
): Promise<typeof issues.$inferSelect> {
  const refData = await getRefData(db);
  const defaultStatus =
    data.statusId ?? refData.statuses.find((s) => s.isDefault)?.id;
  const defaultPriority =
    data.priorityId ?? refData.priorities.find((p) => p.isDefault)?.id;

  if (!defaultStatus || !defaultPriority) {
    throw new Error('Default status or priority is missing — run db seed.');
  }

  // Allocate the next per-project issue number atomically by bumping the
  // project's counter in a single UPDATE ... RETURNING. The returned value is
  // this issue's `number` (RED-<number>); the global serial `id` stays the PK.
  const [seq] = await db
    .update(projects)
    .set({ issueSeq: sql`${projects.issueSeq} + 1` })
    .where(eq(projects.id, data.projectId))
    .returning({ number: projects.issueSeq });
  if (!seq) throw new Error(`Project ${data.projectId} not found`);

  const [created] = await db
    .insert(issues)
    .values({
      projectId: data.projectId,
      number: seq.number,
      trackerId: data.trackerId,
      subject: data.subject,
      description: data.description,
      statusId: defaultStatus,
      priorityId: defaultPriority,
      authorId: user.id,
      assignedToId: data.assignedToId ?? null,
      categoryId: data.categoryId ?? null,
      fixedVersionId: data.fixedVersionId ?? null,
      parentId: data.parentId ?? null,
      startDate: data.startDate ?? null,
      dueDate: data.dueDate ?? null,
      estimatedHours: data.estimatedHours ?? null,
      doneRatio: data.doneRatio,
    })
    .returning();
  /* v8 ignore next */
  if (!created) throw new Error('failed to create issue');

  if (data.labelIds && data.labelIds.length > 0) {
    await setIssueLabelsImpl(db, created.id, data.labelIds);
  }

  // Notify the assignee (if any) and anyone @mentioned in the description.
  await dispatchIssueNotificationsImpl(db, {
    issueId: created.id,
    actorId: user.id,
    newAssigneeId: data.assignedToId ?? null,
    note: data.description,
    notifyWatchers: false,
  });

  await logActivityImpl(db, {
    projectId: data.projectId,
    userId: user.id,
    kind: 'issue_created',
    refId: created.id,
    title: `${user.login} opened issue #${created.id}: ${created.subject}`,
  });

  return created;
}

export const updateIssueSchema = z.object({
  id: z.number(),
  notes: z.string().optional().default(''),
  changes: z.record(z.string(), z.any()).optional().default({}),
});
export type UpdateIssueInput = z.infer<typeof updateIssueSchema>;

export async function updateIssueImpl(
  db: DB,
  user: CurrentUser,
  data: UpdateIssueInput,
  // `notionOrigin=true` means this update originated from the Notion
  // gateway's webhook fan-out, not from a PM-side action.  The flag is
  // recorded on the activity row's `body` column so future tooling can
  // suppress immediate push-back (without re-firing `pushIssueBackground`
  // and ping-ponging the change).  Defaulting to `false` keeps the call
  // sites in `routes/api.notion-webhook.tsx` the only producer of `true`.
  opts: { notionOrigin?: boolean } = {},
): Promise<typeof issues.$inferSelect> {
  const current = await db.query.issues.findFirst({ where: eq(issues.id, data.id) });
  if (!current) throw new Error('Issue not found');

  const accepted = new Set(Object.keys(ISSUE_FIELDS));
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data.changes)) {
    if (accepted.has(k)) patch[k] = v;
  }

  let updated = current;
  const detailRows: Array<{
    property: string;
    prop_key: string;
    oldValue: string | null;
    newValue: string | null;
  }> = [];

  if (Object.keys(patch).length > 0) {
    const refData = await getRefData(db);
    const closedStatus = refData.statuses.find(
      (s) => s.isClosed && !s.isDefault,
    );
    const willClose =
      patch.statusId !== undefined && Number(patch.statusId) === closedStatus?.id;
    const result = await db
      .update(issues)
      .set({
        ...patch,
        updatedAt: new Date(),
        closedAt: willClose ? new Date() : current.closedAt,
      })
      .where(eq(issues.id, data.id))
      .returning();
    /* v8 ignore next */
    if (!result[0]) throw new Error(`issue ${data.id} not found`);
    updated = result[0];

    for (const [k, v] of Object.entries(patch)) {
      const old = (current as Record<string, unknown>)[k];
      if (String(old ?? '') === String(v ?? '')) continue;
      detailRows.push({
        property: 'attr',
        prop_key: ISSUE_FIELDS[k as keyof typeof ISSUE_FIELDS],
        oldValue: old == null ? null : String(old),
        newValue: v == null ? null : String(v),
      });
    }
  }

  if (data.notes.length > 0 || detailRows.length > 0) {
    const [journal] = await db
      .insert(journals)
      .values({ issueId: data.id, userId: user.id, notes: data.notes })
      .returning();
    /* v8 ignore next */
    if (!journal) throw new Error(`failed to create journal for issue ${data.id}`);
    if (detailRows.length > 0) {
      await db
        .insert(journalDetails)
        .values(detailRows.map((d) => ({ ...d, journalId: journal.id })));
    }
    await logActivityImpl(db, {
      projectId: current.projectId,
      userId: user.id,
      kind: data.notes.length > 0 ? 'comment_added' : 'issue_updated',
      refId: data.id,
      title:
        data.notes.length > 0
          ? `${user.login} commented on #${data.id}: ${current.subject}`
          : `${user.login} updated #${data.id}: ${current.subject}`,
      // Record the notion-origin flag on the activity row so consumers /
      // future fanout suppression can opt-in without touching the schema.
      body: opts.notionOrigin ? 'notionOrigin=true' : '',
    });

    // Notify the (new) assignee, @mentioned users in the comment, and watchers.
    const assigneeChanged = detailRows.some((d) => d.prop_key === 'assigned_to');
    await dispatchIssueNotificationsImpl(db, {
      issueId: data.id,
      actorId: user.id,
      newAssigneeId: assigneeChanged
        ? patch.assignedToId == null
          ? null
          : Number(patch.assignedToId)
        : undefined,
      note: data.notes,
      notifyWatchers: true,
      isComment: data.notes.length > 0,
    });
  }

  return updated;
}

export async function watchIssueImpl(
  db: DB,
  user: CurrentUser,
  id: number,
  watch: boolean,
): Promise<{ ok: true }> {
  if (watch) {
    await db.insert(watchers).values({ issueId: id, userId: user.id }).onConflictDoNothing();
  } else {
    await db
      .delete(watchers)
      .where(and(eq(watchers.issueId, id), eq(watchers.userId, user.id)));
  }
  return { ok: true };
}

export async function deleteIssueImpl(db: DB, id: number): Promise<{ ok: true }> {
  await db.delete(issues).where(eq(issues.id, id));
  return { ok: true };
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
/* v8 ignore start */

async function ensureViewAccess(projectId: number) {
  const db = getDb();
  const project = await db.query.projects.findFirst({ where: eq(projects.id, projectId) });
  if (!project) throw new Error('Project not found');
  if (project.isPublic) return;
  const me = await getCurrentUser();
  if (me?.isAdmin) return;
  if (!me) throw new ForbiddenError();
  const ctx = await buildAuthContext(me.id);
  if (!ctx.permissionsByProject[projectId]?.has('view_issues')) throw new ForbiddenError();
}

export const listIssues = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => listIssuesSchema.parse(d))
  .handler(async ({ data }) => {
    await ensureViewAccess(data.projectId);
    return listIssuesImpl(getDb(), data);
  });

export const getIssue = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ id: z.number() }).parse(d))
  .handler(async ({ data }) => {
    const result = await getIssueImpl(getDb(), data.id);
    await ensureViewAccess(result.issue.projectId);
    const me = await getCurrentUser();
    return { ...result, isWatching: me ? result.watchers.includes(me.id) : false };
  });

export const createIssue = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => createIssueSchema.parse(d))
  .handler(async ({ data }) => {
    const db = getDb();
    const env = getEnv();
    const { user } = await requirePermission(data.projectId, 'add_issues');
    const row = await createIssueImpl(db, user, data);
    // Fire-and-forget Notion sync via the gateway.  The gateway returns
    // 404 if the project has no connection yet; the helper swallows that.
    notionGateway.pushIssueBackground(env, undefined, db, row.id);
    return row;
  });

export const updateIssue = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => updateIssueSchema.parse(d))
  .handler(async ({ data }) => {
    const db = getDb();
    const env = getEnv();
    const current = await db.query.issues.findFirst({ where: eq(issues.id, data.id) });
    if (!current) throw new Error('Issue not found');
    const hasChanges = Object.keys(data.changes).length > 0;
    const noteOnly = !hasChanges && data.notes.length > 0;
    const { user } = noteOnly
      ? await requirePermission(current.projectId, 'add_issue_notes')
      : await requirePermission(current.projectId, 'edit_issues');
    const row = await updateIssueImpl(db, user, data);
    notionGateway.pushIssueBackground(env, undefined, db, row.id);
    return row;
  });

export const watchIssue = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), watch: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return watchIssueImpl(getDb(), user, data.id, data.watch);
  });

export const deleteIssue = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number() }).parse(d))
  .handler(async ({ data }) => {
    const db = getDb();
    const issue = await db.query.issues.findFirst({ where: eq(issues.id, data.id) });
    if (!issue) throw new Error('Issue not found');
    await requirePermission(issue.projectId, 'delete_issues');
    return deleteIssueImpl(db, data.id);
  });

/* v8 ignore stop */
