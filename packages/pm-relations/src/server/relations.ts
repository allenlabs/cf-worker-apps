import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '@allenlabs/pm-core/db/client';
import { issueRelations, issueStatuses, issues, projects } from '@allenlabs/pm-core/db/schema';

// Canonical (stored) relation types and their displayed inverse.
export const RELATION_TYPES = ['relates', 'duplicates', 'blocks', 'precedes', 'copied_to'] as const;
export type RelationType = (typeof RELATION_TYPES)[number];

const INVERSE: Record<RelationType, string> = {
  relates: 'relates',
  duplicates: 'duplicated',
  blocks: 'blocked',
  precedes: 'follows',
  copied_to: 'copied_from',
};

export interface RelatedIssue {
  relationId: number;
  /** Display relation type from the perspective of the queried issue. */
  type: string;
  issueId: number;
  number: number;
  projectKey: string;
  subject: string;
  statusIsClosed: boolean;
}

export const addRelationSchema = z.object({
  sourceIssueId: z.number(),
  targetIssueId: z.number(),
  type: z.enum(RELATION_TYPES),
});
export type AddRelationInput = z.infer<typeof addRelationSchema>;

export async function addRelationImpl(db: DB, data: AddRelationInput) {
  if (data.sourceIssueId === data.targetIssueId) {
    throw new Error('An issue cannot relate to itself.');
  }
  const [src, tgt] = await Promise.all([
    db.query.issues.findFirst({ where: eq(issues.id, data.sourceIssueId) }),
    db.query.issues.findFirst({ where: eq(issues.id, data.targetIssueId) }),
  ]);
  if (!src || !tgt) throw new Error('Issue not found');
  if (src.projectId !== tgt.projectId) {
    throw new Error('Related issues must belong to the same project.');
  }
  const existing = await db.query.issueRelations.findFirst({
    where: and(
      eq(issueRelations.sourceIssueId, data.sourceIssueId),
      eq(issueRelations.targetIssueId, data.targetIssueId),
      eq(issueRelations.relationType, data.type),
    ),
  });
  if (existing) throw new Error('That relation already exists.');
  const [row] = await db
    .insert(issueRelations)
    .values({
      sourceIssueId: data.sourceIssueId,
      targetIssueId: data.targetIssueId,
      relationType: data.type,
    })
    .returning();
  /* v8 ignore next */
  if (!row) throw new Error('failed to create relation');
  return row;
}

export async function removeRelationImpl(db: DB, id: number): Promise<{ ok: true }> {
  await db.delete(issueRelations).where(eq(issueRelations.id, id));
  return { ok: true };
}

/**
 * All relations touching `issueId`, normalized to that issue's perspective:
 * rows where it is the source keep the stored type; rows where it is the target
 * are flipped to the inverse type (blocks→blocked, precedes→follows, …).
 */
export async function listRelationsImpl(db: DB, issueId: number): Promise<RelatedIssue[]> {
  const cols = {
    relationId: issueRelations.id,
    relationType: issueRelations.relationType,
    sourceIssueId: issueRelations.sourceIssueId,
    targetIssueId: issueRelations.targetIssueId,
    otherId: issues.id,
    number: issues.number,
    projectKey: projects.key,
    subject: issues.subject,
    statusIsClosed: issueStatuses.isClosed,
  };

  const [outgoing, incoming] = await Promise.all([
    db
      .select(cols)
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.targetIssueId))
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .innerJoin(issueStatuses, eq(issueStatuses.id, issues.statusId))
      .where(eq(issueRelations.sourceIssueId, issueId)),
    db
      .select(cols)
      .from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.sourceIssueId))
      .innerJoin(projects, eq(projects.id, issues.projectId))
      .innerJoin(issueStatuses, eq(issueStatuses.id, issues.statusId))
      .where(eq(issueRelations.targetIssueId, issueId)),
  ]);

  const out: RelatedIssue[] = outgoing.map((r) => ({
    relationId: r.relationId,
    type: r.relationType,
    issueId: r.otherId,
    number: r.number,
    projectKey: r.projectKey,
    subject: r.subject,
    statusIsClosed: r.statusIsClosed,
  }));
  const inc: RelatedIssue[] = incoming.map((r) => ({
    relationId: r.relationId,
    type: INVERSE[r.relationType as RelationType] ?? r.relationType,
    issueId: r.otherId,
    number: r.number,
    projectKey: r.projectKey,
    subject: r.subject,
    statusIsClosed: r.statusIsClosed,
  }));
  return [...out, ...inc];
}

/**
 * `precedes` edges among a project's issues, for drawing gantt dependency
 * arrows (source bar → target bar). Returns [] when the project has none.
 */
export async function listPrecedesEdgesImpl(
  db: DB,
  projectId: number,
): Promise<Array<{ fromIssueId: number; toIssueId: number }>> {
  const projectIssues = await db
    .select({ id: issues.id })
    .from(issues)
    .where(eq(issues.projectId, projectId));
  const ids = projectIssues.map((i) => i.id);
  if (ids.length === 0) return [];
  const rows = await db
    .select({
      fromIssueId: issueRelations.sourceIssueId,
      toIssueId: issueRelations.targetIssueId,
    })
    .from(issueRelations)
    .where(
      and(
        eq(issueRelations.relationType, 'precedes'),
        inArray(issueRelations.sourceIssueId, ids),
      ),
    );
  return rows;
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
