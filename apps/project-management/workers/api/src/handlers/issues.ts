import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { issues, projects, users } from '../../../web/app/db/schema';
import type { DB } from '../../../web/app/db/client';
import { buildAuthContextImpl, type CurrentUser } from '../../../web/app/server/auth';
import {
  countIssuesImpl,
  createIssueImpl,
  getIssueImpl,
  listIssuesImpl,
  updateIssueImpl,
} from '../../../web/app/server/issues';
import { listProjectsImpl } from '../../../web/app/server/projects';
import { getRefData } from '../../../web/app/server/ref-data';
import { type AuthContext, hasPermission, type Permission } from '../../../web/app/lib/permissions';
import { issueKey } from '../../../web/app/lib/format';
import type { AppBindings } from '../context';

export const issuesRouter = new Hono<AppBindings>();

const PAGE_SIZE = 50;

async function loadPrincipal(
  db: DB,
  userId: number,
): Promise<{ me: CurrentUser; ctx: AuthContext } | null> {
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!u) return null;
  const me: CurrentUser = {
    id: u.id,
    login: u.login,
    email: u.email,
    firstname: u.firstname,
    lastname: u.lastname,
    isAdmin: u.admin,
    avatarUrl: u.avatarUrl,
    betterAuthUserId: u.betterAuthUserId,
    username: u.username,
    preferredName: u.preferredName,
  };
  const ctx = await buildAuthContextImpl(db, me);
  return { me, ctx };
}

function can(
  me: CurrentUser,
  ctx: AuthContext,
  project: { id: number; isPublic: boolean },
  perm: Permission,
): boolean {
  if (me.isAdmin) return true;
  if (perm === 'view_issues' && project.isPublic) return true;
  return hasPermission(ctx, project.id, perm);
}

function resolveProject(db: DB, key: string) {
  return db.query.projects.findFirst({ where: eq(projects.key, key.toUpperCase()) });
}

function findByNumber(db: DB, projectId: number, number: number) {
  return db.query.issues.findFirst({
    where: and(eq(issues.projectId, projectId), eq(issues.number, number)),
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function serializeIssue(row: { number: number }, projectKey: string, rest: Record<string, unknown>) {
  return { key: issueKey(projectKey, row.number), ...rest };
}

// GET /v1/projects — projects visible to the client's user.
issuesRouter.get('/projects', async (c) => {
  const db = c.get('db');
  const principal = await loadPrincipal(db, c.get('apiClient').userId);
  if (!principal) return c.json({ error: 'client user missing' }, 401);
  const rows = await listProjectsImpl(db, principal.me, principal.ctx);
  return c.json({
    projects: rows.map((p) => ({ id: p.id, identifier: p.identifier, key: p.key, name: p.name, status: p.status })),
  });
});

// GET /v1/projects/:key/issues?status=open|closed|all&page=
issuesRouter.get('/projects/:key/issues', async (c) => {
  const db = c.get('db');
  const principal = await loadPrincipal(db, c.get('apiClient').userId);
  if (!principal) return c.json({ error: 'client user missing' }, 401);
  const project = await resolveProject(db, c.req.param('key'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  if (!can(principal.me, principal.ctx, project, 'view_issues')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const status = c.req.query('status');
  const statusFilter = status === 'closed' || status === 'all' ? status : 'open';
  const page = Math.max(1, Number(c.req.query('page') ?? '1') || 1);
  const filters = { projectId: project.id, statusFilter } as const;
  const [rows, total] = await Promise.all([
    listIssuesImpl(db, { ...filters, sort: 'id', limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countIssuesImpl(db, filters),
  ]);
  return c.json({
    page,
    pageSize: PAGE_SIZE,
    total,
    issues: rows.map((r) =>
      serializeIssue(r, r.projectKey, {
        id: r.id,
        number: r.number,
        subject: r.subject,
        status: r.statusName,
        priority: r.priorityName,
        tracker: r.trackerName,
        assignee: r.assigneeLogin,
        doneRatio: r.doneRatio,
        dueDate: r.dueDate,
        updatedAt: r.updatedAt,
      }),
    ),
  });
});

// GET /v1/projects/:key/issues/:number
issuesRouter.get('/projects/:key/issues/:number', async (c) => {
  const db = c.get('db');
  const principal = await loadPrincipal(db, c.get('apiClient').userId);
  if (!principal) return c.json({ error: 'client user missing' }, 401);
  const project = await resolveProject(db, c.req.param('key'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  if (!can(principal.me, principal.ctx, project, 'view_issues')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const number = Number(c.req.param('number'));
  const row = await db.query.issues.findFirst({
    where: and(eq(issues.projectId, project.id), eq(issues.number, number)),
  });
  if (!row) return c.json({ error: 'issue not found' }, 404);
  const full = await getIssueImpl(db, row.id);
  return c.json({
    key: issueKey(project.key, full.issue.number),
    id: full.issue.id,
    number: full.issue.number,
    subject: full.issue.subject,
    description: full.issue.description,
    status: full.status?.name ?? null,
    priority: full.priority?.name ?? null,
    tracker: full.tracker?.name ?? null,
    assignee: full.assignee?.login ?? null,
    author: full.author?.login ?? null,
    doneRatio: full.issue.doneRatio,
    startDate: full.issue.startDate,
    dueDate: full.issue.dueDate,
    parent: full.parent ? issueKey(project.key, full.parent.number) : null,
    children: full.children.map((k) => issueKey(project.key, k.number)),
    labels: full.labels.map((l) => l.name),
    relations: full.relations.map((r) => ({ type: r.type, key: issueKey(r.projectKey, r.number) })),
  });
});

const createBody = z.object({
  subject: z.string().min(1).max(255),
  description: z.string().optional(),
  trackerId: z.number().optional(),
  priorityId: z.number().optional(),
  assignedToId: z.number().nullable().optional(),
  startDate: z.string().nullable().optional(),
  dueDate: z.string().nullable().optional(),
  estimatedHours: z.number().nullable().optional(),
  doneRatio: z.number().int().min(0).max(100).optional(),
  labelIds: z.array(z.number()).optional(),
  // Parent issue's per-project number (e.g. 3 for RED-3); creates a subtask.
  parentNumber: z.number().optional(),
});

// POST /v1/projects/:key/issues
issuesRouter.post('/projects/:key/issues', async (c) => {
  const db = c.get('db');
  const principal = await loadPrincipal(db, c.get('apiClient').userId);
  if (!principal) return c.json({ error: 'client user missing' }, 401);
  const project = await resolveProject(db, c.req.param('key'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  if (!can(principal.me, principal.ctx, project, 'add_issues')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let parsed: unknown;
  try {
    parsed = c.get('rawBody') ? JSON.parse(c.get('rawBody')) : {};
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = createBody.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const refData = await getRefData(db);
  const trackerId = result.data.trackerId ?? refData.trackers[0]?.id;
  if (!trackerId) return c.json({ error: 'no tracker available' }, 422);
  let parentId: number | null = null;
  if (result.data.parentNumber != null) {
    const parent = await findByNumber(db, project.id, result.data.parentNumber);
    if (!parent) return c.json({ error: `parent #${result.data.parentNumber} not found` }, 422);
    parentId = parent.id;
  }
  let created;
  try {
    created = await createIssueImpl(db, principal.me, {
      projectId: project.id,
      trackerId,
      subject: result.data.subject,
      description: result.data.description ?? '',
      priorityId: result.data.priorityId,
      assignedToId: result.data.assignedToId ?? null,
      startDate: result.data.startDate ?? null,
      dueDate: result.data.dueDate ?? null,
      estimatedHours: result.data.estimatedHours ?? null,
      doneRatio: result.data.doneRatio ?? 0,
      labelIds: result.data.labelIds,
      parentId,
    });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 422);
  }
  return c.json({ key: issueKey(project.key, created.number), id: created.id, number: created.number }, 201);
});

const updateBody = z.object({
  notes: z.string().optional(),
  changes: z.record(z.string(), z.unknown()).optional(),
});

// POST /v1/projects/:key/issues/:number — apply changes / add a note.
issuesRouter.post('/projects/:key/issues/:number', async (c) => {
  const db = c.get('db');
  const principal = await loadPrincipal(db, c.get('apiClient').userId);
  if (!principal) return c.json({ error: 'client user missing' }, 401);
  const project = await resolveProject(db, c.req.param('key'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  const number = Number(c.req.param('number'));
  const row = await db.query.issues.findFirst({
    where: and(eq(issues.projectId, project.id), eq(issues.number, number)),
  });
  if (!row) return c.json({ error: 'issue not found' }, 404);

  let parsed: unknown;
  try {
    parsed = c.get('rawBody') ? JSON.parse(c.get('rawBody')) : {};
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const result = updateBody.safeParse(parsed);
  if (!result.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(result.error) }, 422);
  }
  const notes = result.data.notes ?? '';
  const changes = result.data.changes ?? {};
  const noteOnly = Object.keys(changes).length === 0 && notes.length > 0;
  const perm: Permission = noteOnly ? 'add_issue_notes' : 'edit_issues';
  if (!can(principal.me, principal.ctx, project, perm)) {
    return c.json({ error: 'forbidden' }, 403);
  }
  let updated;
  try {
    updated = await updateIssueImpl(db, principal.me, { id: row.id, notes, changes });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 422);
  }
  return c.json({ key: issueKey(project.key, updated.number), id: updated.id, number: updated.number });
});

// POST /v1/projects/:key/issues/:number/parent — re-parent THIS issue.
// Body: { parentNumber: number | null }  (null detaches it)
issuesRouter.post('/projects/:key/issues/:number/parent', async (c) => {
  const db = c.get('db');
  const principal = await loadPrincipal(db, c.get('apiClient').userId);
  if (!principal) return c.json({ error: 'client user missing' }, 401);
  const project = await resolveProject(db, c.req.param('key'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  if (!can(principal.me, principal.ctx, project, 'edit_issues')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const row = await findByNumber(db, project.id, Number(c.req.param('number')));
  if (!row) return c.json({ error: 'issue not found' }, 404);

  let parsed: unknown;
  try {
    parsed = c.get('rawBody') ? JSON.parse(c.get('rawBody')) : {};
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const body = z.object({ parentNumber: z.number().nullable() }).safeParse(parsed);
  if (!body.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(body.error) }, 422);
  }
  let parentId: number | null = null;
  if (body.data.parentNumber != null) {
    const parent = await findByNumber(db, project.id, body.data.parentNumber);
    if (!parent) return c.json({ error: `parent #${body.data.parentNumber} not found` }, 422);
    parentId = parent.id;
  }
  try {
    await updateIssueImpl(db, principal.me, { id: row.id, notes: '', changes: { parentId } });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 422);
  }
  return c.json({
    key: issueKey(project.key, row.number),
    parent: parentId == null ? null : issueKey(project.key, body.data.parentNumber!),
  });
});

// POST /v1/projects/:key/issues/:number/children — attach a subtask:
// make childNumber a child of THIS issue. Body: { childNumber: number }
issuesRouter.post('/projects/:key/issues/:number/children', async (c) => {
  const db = c.get('db');
  const principal = await loadPrincipal(db, c.get('apiClient').userId);
  if (!principal) return c.json({ error: 'client user missing' }, 401);
  const project = await resolveProject(db, c.req.param('key'));
  if (!project) return c.json({ error: 'project not found' }, 404);
  if (!can(principal.me, principal.ctx, project, 'edit_issues')) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const parent = await findByNumber(db, project.id, Number(c.req.param('number')));
  if (!parent) return c.json({ error: 'issue not found' }, 404);

  let parsed: unknown;
  try {
    parsed = c.get('rawBody') ? JSON.parse(c.get('rawBody')) : {};
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const body = z.object({ childNumber: z.number() }).safeParse(parsed);
  if (!body.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(body.error) }, 422);
  }
  const child = await findByNumber(db, project.id, body.data.childNumber);
  if (!child) return c.json({ error: `child #${body.data.childNumber} not found` }, 422);
  try {
    await updateIssueImpl(db, principal.me, { id: child.id, notes: '', changes: { parentId: parent.id } });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 422);
  }
  return c.json({
    parent: issueKey(project.key, parent.number),
    child: issueKey(project.key, child.number),
  });
});
