import { definePmPlugin } from '@allenlabs/pm-core/host/types';
import {
  assertParentSameProjectImpl,
  assertValidParentImpl,
  rollupParentDoneRatioImpl,
} from '~/server/subtasks';

/** Parent/child subtask hierarchy: validation + done-ratio roll-up. */
export const subtasksPlugin = definePmPlugin({
  id: 'subtasks',
  hooks: {
    async onBeforeIssueCreate(ctx, { projectId, input }) {
      if (input.parentId != null) {
        await assertParentSameProjectImpl(ctx.db, projectId, input.parentId);
      }
    },
    async onIssueCreated(ctx, { input }) {
      if (input.parentId != null) {
        await rollupParentDoneRatioImpl(ctx.db, input.parentId);
      }
    },
    async onBeforeIssueUpdate(ctx, { current, patch }) {
      if ('parentId' in patch) {
        const newParent = patch.parentId == null ? null : Number(patch.parentId);
        if (newParent !== (current.parentId ?? null)) {
          await assertValidParentImpl(ctx.db, current.id, newParent);
        }
      }
    },
    async onIssueUpdated(ctx, { before, after, patch }) {
      // A re-parent touches the old and new parent; a done-ratio change touches
      // the issue's own parent.
      if ('parentId' in patch) {
        if (before.parentId) await rollupParentDoneRatioImpl(ctx.db, before.parentId);
        if (after.parentId) await rollupParentDoneRatioImpl(ctx.db, after.parentId);
      } else if (after.parentId != null && after.doneRatio !== before.doneRatio) {
        await rollupParentDoneRatioImpl(ctx.db, after.parentId);
      }
    },
  },
});
