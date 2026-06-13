// Thin TanStack Start server-fn wrappers for issue relations. The logic +
// vocabulary live in @allenlabs/pm-relations; this file binds the SSR runtime
// (getDb / requirePermission) and resolves the human-entered per-project number
// to a global id. Exercised by the wrangler integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { issues } from '@allenlabs/pm-core/db/schema';
import { RELATION_TYPES, addRelationImpl, removeRelationImpl } from '@allenlabs/pm-relations';
import { getDb, requirePermission } from './auth-runtime.server';

async function resolveProjectId(issueId: number): Promise<number> {
  const db = getDb();
  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) throw new Error('Issue not found');
  return issue.projectId;
}

export const addRelation = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({ sourceIssueId: z.number(), targetNumber: z.number(), type: z.enum(RELATION_TYPES) })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const db = getDb();
    const projectId = await resolveProjectId(data.sourceIssueId);
    await requirePermission(projectId, 'edit_issues');
    // Resolve the human-entered per-project number to a global issue id.
    const target = await db.query.issues.findFirst({
      where: and(eq(issues.projectId, projectId), eq(issues.number, data.targetNumber)),
    });
    if (!target) throw new Error(`Issue #${data.targetNumber} not found in this project.`);
    return addRelationImpl(db, {
      sourceIssueId: data.sourceIssueId,
      targetIssueId: target.id,
      type: data.type,
    });
  });

export const removeRelation = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), issueId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    const projectId = await resolveProjectId(data.issueId);
    await requirePermission(projectId, 'edit_issues');
    return removeRelationImpl(getDb(), data.id);
  });

/* v8 ignore stop */
