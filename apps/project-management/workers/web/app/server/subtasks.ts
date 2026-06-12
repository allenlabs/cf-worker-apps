import { eq } from 'drizzle-orm';
import { type DB } from '~/db/client';
import { issues } from '~/db/schema';

/**
 * Validate that `childId` may be parented under `parentId` (null = detach). Same
 * project, never itself, and no circular chain. parent_id has no DB FK, so we
 * also guard against pre-existing loops / dangling pointers while walking up.
 */
export async function assertValidParentImpl(
  db: DB,
  childId: number,
  parentId: number | null,
): Promise<void> {
  if (parentId == null) return;
  if (parentId === childId) throw new Error('An issue cannot be its own parent.');
  const child = await db.query.issues.findFirst({ where: eq(issues.id, childId) });
  if (!child) throw new Error('Issue not found');
  const parent = await db.query.issues.findFirst({ where: eq(issues.id, parentId) });
  if (!parent) throw new Error('Parent issue not found');
  if (parent.projectId !== child.projectId) {
    throw new Error('Parent must be in the same project.');
  }
  // Walk up from the proposed parent; reaching childId would form a cycle.
  const seen = new Set<number>();
  let cursor: number | null = parent.parentId;
  while (cursor != null) {
    if (cursor === childId) throw new Error('That would create a circular parent chain.');
    if (seen.has(cursor)) break; // pre-existing loop in data — stop walking
    seen.add(cursor);
    const up = await db.query.issues.findFirst({ where: eq(issues.id, cursor) });
    cursor = up ? up.parentId : null;
  }
}

/**
 * Lightweight parent check for issue creation: the parent must exist in the
 * same project. (A cycle is impossible — the new issue has no children yet.)
 */
export async function assertParentSameProjectImpl(
  db: DB,
  projectId: number,
  parentId: number,
): Promise<void> {
  const parent = await db.query.issues.findFirst({ where: eq(issues.id, parentId) });
  if (!parent || parent.projectId !== projectId) {
    throw new Error('Parent issue must be in the same project.');
  }
}

/**
 * Recompute a parent's done ratio as the average of its children's. No-op when
 * the parent has no children (manual done ratio is left untouched).
 */
export async function rollupParentDoneRatioImpl(db: DB, parentId: number): Promise<void> {
  const kids = await db
    .select({ doneRatio: issues.doneRatio })
    .from(issues)
    .where(eq(issues.parentId, parentId));
  if (kids.length === 0) return;
  const avg = Math.round(kids.reduce((s, k) => s + k.doneRatio, 0) / kids.length);
  await db.update(issues).set({ doneRatio: avg, updatedAt: new Date() }).where(eq(issues.id, parentId));
}
