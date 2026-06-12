import { createServerFn } from '@tanstack/react-start';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '@allenlabs/pm-core/db/client';
import {
  enabledModules,
  issueCategories,
  members,
  projectTrackers,
  projects,
  versions,
  wikis,
} from '@allenlabs/pm-core/db/schema';
import { deriveProjectKey, PROJECT_KEY_RE, slugify } from '@allenlabs/pm-core/lib/format';
import {
  type AuthContext,
  ForbiddenError,
  UnauthorizedError,
} from '@allenlabs/pm-core/lib/permissions';
import { logActivityImpl } from '@allenlabs/pm-core/server/activities';
import { type CurrentUser } from '@allenlabs/pm-core/server/auth';
import type { ProjectCreatedContext, ProjectProvisionResult } from '@allenlabs/pm-core/server/auth/types';
import {
  buildAuthContext,
  getAdapter,
  getDb,
  getCurrentUser,
  getEnv,
  requirePermission,
  requireUser,
} from './auth-runtime.server';
import { getRefData } from '@allenlabs/pm-core/server/ref-data';

const DEFAULT_MODULES = [
  'issue_tracking',
  'time_tracking',
  'wiki',
  'files',
  'gantt',
  'roadmap',
] as const;

export const createProjectSchema = z.object({
  identifier: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[a-z0-9][a-z0-9_-]*$/, 'lowercase letters/numbers/-/_ only'),
  // Optional Jira-style key (RED). Derived from the identifier when omitted.
  key: z.string().max(10).optional(),
  name: z.string().min(1).max(255),
  description: z.string().optional().default(''),
  homepage: z.string().optional().default(''),
  isPublic: z.boolean().optional().default(false),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(255),
  description: z.string(),
  homepage: z.string(),
  isPublic: z.boolean(),
  status: z.enum(['active', 'closed', 'archived']),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

// ---------- impls (testable without TanStack Start runtime) ----------

// Normalize the result shape of `db.execute(sql\`...\`)` across drivers:
//   - postgres.js (production via Hyperdrive) returns a Result that is
//     also a plain array (Array.isArray is true).
//   - drizzle-orm/pglite (unit tests) returns `{ rows: [...], ... }`.
// Returning the underlying row array unifies the two callsites.
// Exported for the unit test; safe to keep on the public API surface.
export function extractRows(result: unknown): unknown[] {
  if (Array.isArray(result)) return result;
  const rows = (result as { rows?: unknown[] } | null | undefined)?.rows;
  return Array.isArray(rows) ? rows : [];
}

export async function listProjectsImpl(
  db: DB,
  me: CurrentUser | null,
  ctx: AuthContext | null,
): Promise<Array<typeof projects.$inferSelect>> {
  const rows = await db.select().from(projects).orderBy(projects.name);
  if (!me) return rows.filter((p) => p.isPublic && p.status === 'active');
  if (me.isAdmin) return rows;
  return rows.filter(
    (p) => p.isPublic || ctx?.permissionsByProject[p.id]?.has('view_project'),
  );
}

export async function getProjectImpl(
  db: DB,
  me: CurrentUser | null,
  ctx: AuthContext | null,
  identifier: string,
) {
  // One CTE pulls the project row, related lookups, and issue counts in
  // a single Hetzner round-trip.  Previously ~7 sequential / parallel
  // queries — ~200 ms savings per warm hit.
  const result = (await db.execute(
    sql`
      WITH
      project_row AS (
        SELECT
          id, identifier, key, name, description, homepage,
          is_public AS "isPublic", parent_id AS "parentId", status,
          created_at AS "createdAt", updated_at AS "updatedAt"
        FROM pm.projects
        WHERE identifier = ${identifier}
        LIMIT 1
      ),
      tracker_rows AS (
        SELECT t.id, t.name, t.color
        FROM pm.project_trackers pt
        JOIN pm.trackers t ON t.id = pt.tracker_id
        WHERE pt.project_id = (SELECT id FROM project_row)
        ORDER BY t.position, t.id
      ),
      module_rows AS (
        SELECT name FROM pm.enabled_modules
        WHERE project_id = (SELECT id FROM project_row)
      ),
      version_rows AS (
        SELECT
          id, name, description, status, sharing,
          due_date AS "dueDate",
          wiki_page AS "wikiPage",
          project_id AS "projectId",
          created_at AS "createdAt"
        FROM pm.versions
        WHERE project_id = (SELECT id FROM project_row)
        ORDER BY due_date NULLS LAST, id
      ),
      category_rows AS (
        SELECT
          id, name, project_id AS "projectId",
          assigned_to_id AS "assignedToId"
        FROM pm.issue_categories
        WHERE project_id = (SELECT id FROM project_row)
      ),
      counts_row AS (
        SELECT
          COALESCE(SUM(CASE WHEN s.is_closed = false THEN 1 ELSE 0 END), 0)::int AS "openIssues",
          COALESCE(SUM(CASE WHEN s.is_closed = true  THEN 1 ELSE 0 END), 0)::int AS "closedIssues"
        FROM pm.issues i
        JOIN pm.issue_statuses s ON s.id = i.status_id
        WHERE i.project_id = (SELECT id FROM project_row)
      ),
      activity_rows AS (
        SELECT
          a.id, a.kind, a.title, a.body,
          a.created_at AS "createdAt",
          a.ref_id   AS "refId",
          a.project_id AS "projectId",
          p.name AS "projectName",
          a.user_id AS "userId",
          u.login AS "userLogin"
        FROM pm.activities a
        LEFT JOIN pm.projects p ON p.id = a.project_id
        INNER JOIN pm.users u ON u.id = a.user_id
        WHERE a.project_id = (SELECT id FROM project_row)
        ORDER BY a.created_at DESC
        LIMIT 10
      )
      SELECT json_build_object(
        'project',    (SELECT row_to_json(p) FROM project_row p),
        'trackers',   COALESCE((SELECT json_agg(t) FROM tracker_rows t), '[]'::json),
        'modules',    COALESCE((SELECT json_agg(m.name) FROM module_rows m), '[]'::json),
        'versions',   COALESCE((SELECT json_agg(v) FROM version_rows v), '[]'::json),
        'categories', COALESCE((SELECT json_agg(c) FROM category_rows c), '[]'::json),
        'counts',     COALESCE(
          (SELECT row_to_json(cr) FROM counts_row cr),
          json_build_object('openIssues', 0, 'closedIssues', 0)
        ),
        'activities', COALESCE((SELECT json_agg(ar) FROM activity_rows ar), '[]'::json)
      ) AS data
    `,
  )) as unknown;
  // `SELECT json_build_object(...)` always returns exactly one row, so
  // arr[0].data is the only place the payload can live.
  const [first] = extractRows(result);
  const data = (first as {
    data?: {
      project: {
        id: number;
        identifier: string;
        key: string;
        name: string;
        description: string;
        homepage: string;
        isPublic: boolean;
        parentId: number | null;
        status: 'active' | 'closed' | 'archived';
        createdAt: string;
        updatedAt: string;
      } | null;
      trackers: Array<{ id: number; name: string; color: string }>;
      modules: string[];
      versions: Array<typeof versions.$inferSelect>;
      categories: Array<typeof issueCategories.$inferSelect>;
      counts: { openIssues: number; closedIssues: number };
      activities: Array<{
        id: number;
        kind: string;
        title: string;
        body: string;
        createdAt: string;
        refId: number | null;
        projectId: number | null;
        projectName: string | null;
        userId: number;
        userLogin: string;
      }>;
    };
  }).data;
  if (!data?.project) throw new Error('Project not found');
  const project = data.project;
  if (!project.isPublic) {
    if (!me) throw new UnauthorizedError();
    if (!me.isAdmin && !ctx?.permissionsByProject[project.id]?.has('view_project')) {
      throw new ForbiddenError();
    }
  }
  return {
    ...project,
    // postgres `json_*` returns timestamps as strings; restore Date so
    // callers keep the same shape as the prior drizzle-driven impl.
    createdAt: new Date(project.createdAt),
    updatedAt: new Date(project.updatedAt),
    trackers: data.trackers,
    modules: data.modules,
    versions: data.versions.map((v) => ({
      ...v,
      createdAt: new Date(v.createdAt as unknown as string),
    })),
    categories: data.categories,
    counts: data.counts,
    activities: data.activities.map((a) => ({
      ...a,
      createdAt: new Date(a.createdAt),
    })),
  };
}

/**
 * Optional team/org provisioning. The auth adapter supplies this (bound to env);
 * absent ⇒ the project is created with pm.members RBAC only (authTeamId null).
 */
export type ProjectProvision = (
  ctx: ProjectCreatedContext,
) => Promise<ProjectProvisionResult>;

export async function createProjectImpl(
  db: DB,
  user: CurrentUser,
  data: CreateProjectInput,
  provision?: ProjectProvision,
): Promise<typeof projects.$inferSelect> {
  const existing = await db.query.projects.findFirst({
    where: eq(projects.identifier, data.identifier),
  });
  if (existing) throw new Error(`Identifier "${data.identifier}" is already used.`);

  // Resolve the Jira-style project key: explicit input (uppercased) or derived
  // from the identifier. Validate the shape and enforce global uniqueness so
  // composed issue keys (`${key}-${number}`) never collide across projects.
  const key = data.key?.trim() ? data.key.trim().toUpperCase() : deriveProjectKey(data.identifier);
  if (!PROJECT_KEY_RE.test(key)) {
    throw new Error(`Invalid project key "${key}" — 1–10 letters/digits, starting with a letter.`);
  }
  const keyTaken = await db.query.projects.findFirst({ where: eq(projects.key, key) });
  if (keyTaken) throw new Error(`Project key "${key}" is already used.`);

  // Let the auth adapter provision a backing team (e.g. a Better Auth team)
  // BEFORE inserting the project so we can store its id. The adapter hook is
  // itself best-effort (returns teamId null on failure), so a project always
  // creates — falling back to pm.members RBAC when there's no team.
  let authTeamId: string | null = null;
  if (provision) {
    const result = await provision({
      actingExternalUserId: user.betterAuthUserId ?? null,
      projectName: data.name,
      projectSlug: data.identifier,
    });
    authTeamId = result.teamId;
  }

  const [project] = await db
    .insert(projects)
    .values({
      identifier: data.identifier,
      key,
      name: data.name,
      description: data.description,
      homepage: data.homepage,
      isPublic: data.isPublic,
      authTeamId,
    })
    .returning();
  /* v8 ignore next */
  if (!project) throw new Error(`failed to create project ${data.identifier}`);

  await db
    .insert(enabledModules)
    .values(DEFAULT_MODULES.map((m) => ({ projectId: project.id, name: m })));

  const refData = await getRefData(db);
  if (refData.trackers.length > 0) {
    await db
      .insert(projectTrackers)
      .values(refData.trackers.map((t) => ({ projectId: project.id, trackerId: t.id })));
  }

  const manager = refData.roles.find((r) => r.name === 'Manager');
  if (manager) {
    await db
      .insert(members)
      .values({ userId: user.id, projectId: project.id, roleId: manager.id });
  }

  await db.insert(wikis).values({ projectId: project.id }).onConflictDoNothing();

  await logActivityImpl(db, {
    projectId: project.id,
    userId: user.id,
    kind: 'project_created',
    refId: project.id,
    title: `${user.login} created project ${project.name}`,
  });

  return project;
}

export async function updateProjectImpl(
  db: DB,
  data: UpdateProjectInput,
): Promise<typeof projects.$inferSelect> {
  const [updated] = await db
    .update(projects)
    .set({
      name: data.name,
      description: data.description,
      homepage: data.homepage,
      isPublic: data.isPublic,
      status: data.status,
      updatedAt: new Date(),
    })
    .where(eq(projects.id, data.id))
    .returning();
  if (!updated) throw new Error('Project not found');
  return updated;
}

export async function deleteProjectImpl(db: DB, id: number): Promise<{ ok: true }> {
  await db.delete(projects).where(eq(projects.id, id));
  return { ok: true };
}

// ---------- TanStack Start wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.  Unit tests
// target the *Impl helpers above directly.
/* v8 ignore start */

export const listProjects = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await getCurrentUser();
  const ctx = me ? await buildAuthContext(me.id) : null;
  return listProjectsImpl(getDb(), me, ctx);
});

export const getProject = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ identifier: z.string() }).parse(d))
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    const ctx = me ? await buildAuthContext(me.id) : null;
    return getProjectImpl(getDb(), me, ctx, data.identifier);
  });

export const createProject = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => createProjectSchema.parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    const env = getEnv();
    const adapter = getAdapter(env);
    const provision = adapter.onProjectCreated
      ? (ctx: ProjectCreatedContext) => adapter.onProjectCreated!(env, ctx)
      : undefined;
    return createProjectImpl(getDb(), user, data, provision);
  });

export const updateProject = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => updateProjectSchema.parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.id, 'edit_project');
    return updateProjectImpl(getDb(), data);
  });

export const deleteProject = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.id, 'delete_project').catch(async () => {
      const u = await requireUser();
      if (!u.isAdmin) throw new ForbiddenError();
    });
    return deleteProjectImpl(getDb(), data.id);
  });

export const suggestIdentifier = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ name: z.string() }).parse(d))
  .handler(async ({ data }) => slugify(data.name));

/* v8 ignore stop */
