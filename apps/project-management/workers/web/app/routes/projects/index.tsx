import { Link, createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { sql } from 'drizzle-orm';
import { getRequest } from '@tanstack/react-start/server';
import { useT } from '@allenlabs/i18n/react';
import { getAdapter, getDb, getEnv } from '~/server/auth-runtime.server';

interface ProjectRow {
  id: number;
  identifier: string;
  name: string;
  description: string;
  homepage: string;
  isPublic: boolean;
  parentId: number | null;
  status: string;
}

// Single SQL that resolves the current user and the projects they can
// see in ONE Hetzner round-trip — same shape as loadHome.  Halves the
// loader wall-time vs the old (getCurrentUser DB) + (buildAuthContext
// DB) + (listProjectsImpl DB) chain.
const loadProjects = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  const req = getRequest();
  const cookie = req?.headers.get('cookie') ?? null;
  const identity = await getAdapter(env).verify(env, cookie);

  const db = getDb();
  if (!identity) {
    // Anonymous (no/invalid session): only public + active. Issue the simpler
    // query so we don't pay for the user-resolution CTE.
    const result = (await db.execute(
      sql`
        SELECT COALESCE(
          (SELECT json_agg(p) FROM (
            SELECT
              id, identifier, name, description, homepage,
              is_public AS "isPublic", parent_id AS "parentId", status
            FROM pm.projects
            WHERE is_public AND status = 'active'
            ORDER BY name
          ) p),
          '[]'::json
        ) AS data
      `,
    )) as unknown;
    const arr0 = Array.isArray(result)
      ? result
      : (result as { rows?: unknown[] }).rows;
    return arr0 && arr0.length > 0
      ? ((arr0[0] as { data?: ProjectRow[] }).data ?? [])
      : [];
  }
  const sub = identity.subject;
  // Phase 2: a project is visible if its Better Auth team id is among the
  // user's JWT team memberships. drizzle's `sql` template EXPANDS a JS array
  // into separate placeholders (for IN-lists), which breaks `= ANY($n::text[])`.
  // So we build a single Postgres array literal string and bind it as ONE
  // scalar param, casting it to text[] in SQL. Empty list => '{}' which ANY
  // never matches. Team ids are [A-Za-z0-9_] so no escaping is needed, but we
  // defensively strip anything else.
  const teamIds = (identity.teamMemberships ?? []).map((t) => t.teamId);
  const teamIdArrayLiteral =
    '{' + teamIds.map((id) => id.replace(/[^A-Za-z0-9_-]/g, '')).join(',') + '}';

  const result = (await db.execute(
    sql`
  WITH
  me AS (
    SELECT id, admin AS "isAdmin" FROM pm.users
    WHERE better_auth_user_id = ${sub} AND status = 'active' LIMIT 1
  ),
  visible AS (
    SELECT
      p.id,
      p.identifier,
      p.name,
      p.description,
      p.homepage,
      p.is_public      AS "isPublic",
      p.parent_id      AS "parentId",
      p.status
    FROM pm.projects p
    WHERE
      -- Admin sees everything; non-admin gets public OR team membership
      -- (Phase 2) OR legacy pm.members membership.
      (SELECT "isAdmin" FROM me LIMIT 1) = true
      OR p.is_public
      OR (p.auth_team_id IS NOT NULL AND p.auth_team_id = ANY(${teamIdArrayLiteral}::text[]))
      OR EXISTS (
        SELECT 1 FROM pm.members m
        WHERE m.user_id = (SELECT id FROM me) AND m.project_id = p.id
      )
    ORDER BY p.name
  )
  SELECT COALESCE(json_agg(v), '[]'::json) AS data FROM visible v
    `,
  )) as unknown;
  const arr = Array.isArray(result) ? result : (result as { rows?: unknown[] }).rows;
  return arr && arr.length > 0
    ? ((arr[0] as { data?: ProjectRow[] }).data ?? [])
    : [];
});

export const Route = createFileRoute('/projects/')({
  loader: () => loadProjects(),
  component: ProjectsListPage,
});

function ProjectsListPage() {
  const projects = Route.useLoaderData() ?? [];
  const { t } = useT();

  if (projects.length === 0) {
    return (
      <section className="card p-10 max-w-2xl mx-auto text-center">
        <h1 className="text-2xl font-semibold mb-3">{t('projects.emptyTitle')}</h1>
        <p className="text-sm text-gray-600 mb-6">
          {t('projects.emptyBody')}
        </p>
        <Link to="/projects/new" className="btn-primary">{t('projects.newProject')}</Link>
      </section>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h1 className="text-2xl font-semibold">{t('projects.title')}</h1>
        <Link to="/projects/new" className="btn-primary">{t('projects.newProject')}</Link>
      </div>
      <ul className="card divide-y divide-gray-100">
        {projects.map((p) => (
          <li key={p.id} className="p-4" data-testid={`project-row-${p.identifier}`}>
            <div className="flex items-center justify-between">
              <Link
                to="/projects/$identifier"
                params={{ identifier: p.identifier }}
                className="font-medium text-base"
              >
                {p.name}
              </Link>
              <span className="text-xs text-gray-500">
                {p.isPublic ? t('projects.visibilityPublic') : t('projects.visibilityPrivate')} · {p.status}
              </span>
            </div>
            <div className="text-xs text-gray-500 mt-0.5">{p.identifier}</div>
            {p.description ? <p className="text-sm text-gray-700 mt-1">{p.description}</p> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
