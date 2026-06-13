import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '@allenlabs/pm-core/db/client';
import { issueLabels, issues, labels } from '@allenlabs/pm-core/db/schema';

export type LabelRow = typeof labels.$inferSelect;

export async function listLabelsImpl(db: DB, projectId: number): Promise<LabelRow[]> {
  return db.query.labels.findMany({
    where: eq(labels.projectId, projectId),
    orderBy: labels.name,
  });
}

export const createLabelSchema = z.object({
  projectId: z.number(),
  name: z.string().min(1).max(60),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
});
export type CreateLabelInput = z.infer<typeof createLabelSchema>;

export async function createLabelImpl(db: DB, data: CreateLabelInput): Promise<LabelRow> {
  const name = data.name.trim();
  const existing = await db.query.labels.findFirst({
    where: and(eq(labels.projectId, data.projectId), eq(labels.name, name)),
  });
  if (existing) throw new Error(`Label "${name}" already exists in this project.`);
  const [row] = await db
    .insert(labels)
    .values({ projectId: data.projectId, name, color: data.color ?? '#6b7280' })
    .returning();
  /* v8 ignore next */
  if (!row) throw new Error('failed to create label');
  return row;
}

export async function deleteLabelImpl(db: DB, id: number): Promise<{ ok: true }> {
  await db.delete(labels).where(eq(labels.id, id));
  return { ok: true };
}

/**
 * Replace the full label set on an issue. Only labels belonging to the issue's
 * own project are accepted — cross-project label ids are silently dropped so a
 * forged request can't tag an issue with another project's label.
 */
export async function setIssueLabelsImpl(
  db: DB,
  issueId: number,
  labelIds: number[],
): Promise<{ ok: true }> {
  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) throw new Error('Issue not found');

  await db.delete(issueLabels).where(eq(issueLabels.issueId, issueId));

  const unique = [...new Set(labelIds)];
  if (unique.length > 0) {
    const valid = await db
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.projectId, issue.projectId), inArray(labels.id, unique)));
    if (valid.length > 0) {
      await db
        .insert(issueLabels)
        .values(valid.map((l) => ({ issueId, labelId: l.id })))
        .onConflictDoNothing();
    }
  }
  return { ok: true };
}

/** Labels currently attached to a single issue. */
export async function listIssueLabelsImpl(db: DB, issueId: number): Promise<LabelRow[]> {
  const rows = await db
    .select({
      id: labels.id,
      projectId: labels.projectId,
      name: labels.name,
      color: labels.color,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(eq(issueLabels.issueId, issueId))
    .orderBy(labels.name);
  return rows;
}

/**
 * Map issueId → its labels for a batch of issues (issue-list chips). Returns an
 * empty Map for an empty input so callers can index without a guard.
 */
export async function labelsByIssueImpl(
  db: DB,
  issueIds: number[],
): Promise<Map<number, LabelRow[]>> {
  const out = new Map<number, LabelRow[]>();
  if (issueIds.length === 0) return out;
  const rows = await db
    .select({
      issueId: issueLabels.issueId,
      id: labels.id,
      projectId: labels.projectId,
      name: labels.name,
      color: labels.color,
    })
    .from(issueLabels)
    .innerJoin(labels, eq(labels.id, issueLabels.labelId))
    .where(inArray(issueLabels.issueId, issueIds))
    .orderBy(labels.name);
  for (const r of rows) {
    const list = out.get(r.issueId) ?? [];
    list.push({ id: r.id, projectId: r.projectId, name: r.name, color: r.color });
    out.set(r.issueId, list);
  }
  return out;
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
