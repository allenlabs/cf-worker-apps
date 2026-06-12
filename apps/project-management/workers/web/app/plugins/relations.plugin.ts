import { and, eq } from 'drizzle-orm';
import { definePmPlugin } from '~/host/types';
import { issues } from '@allenlabs/pm-core/db/schema';
import type { DB } from '@allenlabs/pm-core/db/client';
import { addRelationImpl } from '~/server/relations';

function findByNumber(db: DB, projectId: number, number: number) {
  return db.query.issues.findFirst({
    where: and(eq(issues.projectId, projectId), eq(issues.number, number)),
  });
}

/** Relations declared at issue creation (relates/blocks/duplicates/…). */
export const relationsPlugin = definePmPlugin({
  id: 'relations',
  hooks: {
    // Pre-resolve targets BEFORE the issue row is inserted so a bad target
    // fails with no orphaned issue.
    async onBeforeIssueCreate(ctx, { projectId, input }) {
      if (!input.relations) return;
      for (const rel of input.relations) {
        const target = await findByNumber(ctx.db, projectId, rel.targetNumber);
        if (!target) {
          throw new Error(`Related issue #${rel.targetNumber} not found in this project.`);
        }
      }
    },
    async onIssueCreated(ctx, { issue, input }) {
      if (!input.relations) return;
      for (const rel of input.relations) {
        const target = await findByNumber(ctx.db, issue.projectId, rel.targetNumber);
        /* v8 ignore next — validated in onBeforeIssueCreate; unreachable here. */
        if (!target) continue;
        await addRelationImpl(ctx.db, {
          sourceIssueId: issue.id,
          targetIssueId: target.id,
          type: rel.type,
        });
      }
    },
  },
});
