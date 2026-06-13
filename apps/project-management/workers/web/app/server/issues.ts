// Thin TanStack Start server-fn wrappers for issues. The logic lives in
// @allenlabs/pm-core/server/issues; this file binds the SSR runtime
// (auth-runtime helpers), composes-in the app's plugin `host` (so the core
// impls stay host-agnostic), and fires the fire-and-forget Notion sync.
// Exercised by the wrangler integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { issues, projects } from '@allenlabs/pm-core/db/schema';
import { ForbiddenError } from '@allenlabs/pm-core/lib/permissions';
import {
  createIssueImpl,
  createIssueSchema,
  deleteIssueImpl,
  getIssueImpl,
  listIssuesImpl,
  listIssuesSchema,
  updateIssueImpl,
  updateIssueSchema,
  watchIssueImpl,
} from '@allenlabs/pm-core/server/issues';
import { host } from '~/host';
import type { listIssueLabelsImpl } from '~/server/labels';
import type { listRelationsImpl } from '~/server/relations';
import {
  buildAuthContext,
  getDb,
  getCurrentUser,
  getEnv,
  requirePermission,
  requireUser,
} from './auth-runtime.server';
import * as notionGateway from './notion-gateway-client';

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
    const me = await getCurrentUser();
    const result = await getIssueImpl(getDb(), data.id, host, me);
    await ensureViewAccess(result.issue.projectId);
    // This app composes the labels + relations plugins, so the issue-detail
    // hook always populates these slices; re-type them for the route/components.
    const out = { ...result, isWatching: me ? result.watchers.includes(me.id) : false };
    return out as typeof out & {
      labels: Awaited<ReturnType<typeof listIssueLabelsImpl>>;
      relations: Awaited<ReturnType<typeof listRelationsImpl>>;
    };
  });

export const createIssue = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => createIssueSchema.parse(d))
  .handler(async ({ data }) => {
    const db = getDb();
    const env = getEnv();
    const { user } = await requirePermission(data.projectId, 'add_issues');
    const row = await createIssueImpl(db, user, data, host);
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
    const row = await updateIssueImpl(db, user, data, host);
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

// Re-parent THIS issue under another (parentNumber=null detaches it). The parent
// is given by its per-project number; resolution + all validation/roll-up run
// through updateIssueImpl (and thus the subtasks plugin).
export const setIssueParent = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ issueId: z.number(), parentNumber: z.number().nullable() }).parse(d),
  )
  .handler(async ({ data }) => {
    const db = getDb();
    const issue = await db.query.issues.findFirst({ where: eq(issues.id, data.issueId) });
    if (!issue) throw new Error('Issue not found');
    const { user } = await requirePermission(issue.projectId, 'edit_issues');
    let parentId: number | null = null;
    if (data.parentNumber != null) {
      const parent = await db.query.issues.findFirst({
        where: and(eq(issues.projectId, issue.projectId), eq(issues.number, data.parentNumber)),
      });
      if (!parent) throw new Error(`Issue #${data.parentNumber} not found in this project.`);
      parentId = parent.id;
    }
    return updateIssueImpl(db, user, { id: data.issueId, notes: '', changes: { parentId } }, host);
  });

// Make THIS issue the parent of another (the child given by its per-project
// number) — i.e. attach a subtask under this one.
export const addChildIssue = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ issueId: z.number(), childNumber: z.number() }).parse(d),
  )
  .handler(async ({ data }) => {
    const db = getDb();
    const issue = await db.query.issues.findFirst({ where: eq(issues.id, data.issueId) });
    if (!issue) throw new Error('Issue not found');
    const { user } = await requirePermission(issue.projectId, 'edit_issues');
    const child = await db.query.issues.findFirst({
      where: and(eq(issues.projectId, issue.projectId), eq(issues.number, data.childNumber)),
    });
    if (!child) throw new Error(`Issue #${data.childNumber} not found in this project.`);
    return updateIssueImpl(db, user, { id: child.id, notes: '', changes: { parentId: data.issueId } }, host);
  });

/* v8 ignore stop */
