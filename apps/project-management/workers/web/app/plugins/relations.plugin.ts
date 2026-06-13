import { and, eq } from 'drizzle-orm';
import { definePmPlugin } from '@allenlabs/pm-core/host/types';
import { issues } from '@allenlabs/pm-core/db/schema';
import type { DB } from '@allenlabs/pm-core/db/client';
import {
  RELATION_TYPES,
  type RelationType,
  addRelationImpl,
  listRelationsImpl,
} from '~/server/relations';

function findByNumber(db: DB, projectId: number, number: number) {
  return db.query.issues.findFirst({
    where: and(eq(issues.projectId, projectId), eq(issues.number, number)),
  });
}

const RELATION_TYPE_SET = new Set<string>(RELATION_TYPES);

/** Relations declared at issue creation + contributed to issue detail. */
export const relationsPlugin = definePmPlugin({
  id: 'relations',
  hooks: {
    // Pre-resolve targets + validate the relation type BEFORE the issue row is
    // inserted so a bad input fails with no orphaned issue. The core schema
    // carries `relations` generically (type: string); the relation vocabulary
    // is owned here, not by the core.
    async onBeforeIssueCreate(ctx, { projectId, input }) {
      if (!input.relations) return;
      for (const rel of input.relations) {
        if (!RELATION_TYPE_SET.has(rel.type)) {
          throw new Error(`Unknown relation type "${rel.type}".`);
        }
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
          type: rel.type as RelationType,
        });
      }
    },
    async onIssueDetailLoad(ctx, { issue, detail }) {
      detail.relations = await listRelationsImpl(ctx.db, issue.id);
    },
  },
});
