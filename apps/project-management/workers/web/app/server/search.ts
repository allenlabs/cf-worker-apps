import { createServerFn } from '@tanstack/react-start';
import { and, eq, like, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '~/db/client';
import { issues, projects, wikiPages, wikiRevisions, wikis } from '~/db/schema';
import { type AuthContext } from '~/lib/permissions';
import { type CurrentUser } from './auth';
import { buildAuthContext, getCurrentUser, getDb } from './auth-runtime.server';

export interface SearchInput {
  q: string;
  projectId?: number;
}

export interface SearchResult {
  issues: Array<{
    kind: 'issue';
    id: number;
    number: number;
    projectKey: string;
    projectId: number;
    title: string;
    snippet: string;
    updatedAt: Date;
  }>;
  wikis: Array<{
    kind: 'wiki';
    id: number;
    projectId: number | null;
    title: string;
    snippet: string | null;
    updatedAt: Date;
  }>;
}

export async function visibleProjectIdsImpl(
  db: DB,
  me: CurrentUser | null,
  ctx: AuthContext | null,
): Promise<number[]> {
  if (me?.isAdmin) {
    const all = await db.select({ id: projects.id }).from(projects);
    return all.map((p) => p.id);
  }
  const pub = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.isPublic, true), eq(projects.status, 'active')));
  if (!me) return pub.map((p) => p.id);
  const set = new Set(pub.map((p) => p.id));
  const perms = ctx?.permissionsByProject ?? {};
  for (const id of Object.keys(perms)) {
    set.add(Number(id));
  }
  return Array.from(set);
}

export async function searchImpl(
  db: DB,
  me: CurrentUser | null,
  ctx: AuthContext | null,
  input: SearchInput,
): Promise<SearchResult> {
  const visible = await visibleProjectIdsImpl(db, me, ctx);
  if (!visible.length) return { issues: [], wikis: [] };

  const pattern = `%${input.q}%`;
  const projectFilter = sql`${issues.projectId} IN (${sql.join(
    visible.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  const issueConds = [or(like(issues.subject, pattern), like(issues.description, pattern)), projectFilter];
  if (input.projectId !== undefined) issueConds.push(eq(issues.projectId, input.projectId));

  const issueRows = await db
    .select({
      kind: sql<'issue'>`'issue'`,
      id: issues.id,
      number: issues.number,
      projectKey: projects.key,
      projectId: issues.projectId,
      title: issues.subject,
      snippet: issues.description,
      updatedAt: issues.updatedAt,
    })
    .from(issues)
    .innerJoin(projects, eq(projects.id, issues.projectId))
    .where(and(...issueConds))
    .limit(50);

  const wikiProjectFilter = sql`${wikis.projectId} IN (${sql.join(
    visible.map((id) => sql`${id}`),
    sql`, `,
  )})`;
  const wikiConds = [
    or(like(wikiPages.title, pattern), like(wikiRevisions.text, pattern)),
    wikiProjectFilter,
  ];
  if (input.projectId !== undefined) wikiConds.push(eq(wikis.projectId, input.projectId));

  const wikiRows = await db
    .select({
      kind: sql<'wiki'>`'wiki'`,
      id: wikiPages.id,
      projectId: wikis.projectId,
      title: wikiPages.title,
      snippet: wikiRevisions.text,
      updatedAt: wikiPages.updatedAt,
    })
    .from(wikiPages)
    .innerJoin(wikis, eq(wikis.id, wikiPages.wikiId))
    .leftJoin(wikiRevisions, eq(wikiRevisions.id, wikiPages.currentRevisionId))
    .where(and(...wikiConds))
    .limit(50);

  return { issues: issueRows as SearchResult['issues'], wikis: wikiRows as SearchResult['wikis'] };
}

// ---------- wrappers ----------
// Covered by wrangler integration tests.
/* v8 ignore start */
export const search = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z.object({ q: z.string().min(1), projectId: z.number().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const me = await getCurrentUser();
    const ctx = me ? await buildAuthContext(me.id) : null;
    return searchImpl(getDb(), me, ctx, data);
  });

/* v8 ignore stop */
