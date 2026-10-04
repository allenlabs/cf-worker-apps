import { and, desc, eq } from 'drizzle-orm';
import { type DB } from '../db/client';
import { activities, projects, users } from '../db/schema';

type Kind =
  | 'issue_created'
  | 'issue_updated'
  | 'issue_closed'
  | 'comment_added'
  | 'wiki_edited'
  | 'time_logged'
  | 'project_created';

export interface LogActivityInput {
  projectId: number | null;
  userId: number;
  kind: Kind;
  refId?: number | null;
  title: string;
  body?: string;
}

export async function logActivityImpl(db: DB, input: LogActivityInput): Promise<void> {
  await db.insert(activities).values({
    projectId: input.projectId ?? null,
    userId: input.userId,
    kind: input.kind,
    refId: input.refId ?? null,
    title: input.title,
    body: input.body ?? '',
  });
}

export interface ActivityRow {
  id: number;
  kind: Kind;
  title: string;
  body: string;
  createdAt: Date;
  refId: number | null;
  projectId: number | null;
  projectName: string | null;
  userId: number;
  userLogin: string;
}

export async function listActivitiesImpl(
  db: DB,
  opts: { projectId?: number; siteId?: number; limit?: number } = {},
): Promise<ActivityRow[]> {
  // Site scoping: limit to activities whose project belongs to the site (the
  // projects LEFT JOIN already exists). Siteless ⇒ no filter (unchanged).
  const conds = [];
  if (opts.projectId !== undefined) conds.push(eq(activities.projectId, opts.projectId));
  if (opts.siteId !== undefined) conds.push(eq(projects.siteId, opts.siteId));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: activities.id,
      kind: activities.kind,
      title: activities.title,
      body: activities.body,
      createdAt: activities.createdAt,
      refId: activities.refId,
      projectId: activities.projectId,
      projectName: projects.name,
      userId: activities.userId,
      userLogin: users.login,
    })
    .from(activities)
    .leftJoin(projects, eq(projects.id, activities.projectId))
    .innerJoin(users, eq(users.id, activities.userId))
    .where(where)
    .orderBy(desc(activities.createdAt))
    .limit(opts.limit ?? 50);
  return rows as ActivityRow[];
}
