import { definePmPlugin } from '@allenlabs/pm-core/host/types';
import { listIssueLabelsImpl, setIssueLabelsImpl } from '~/server/labels';

/** Labels: apply those chosen at creation + contribute them to issue detail. */
export const labelsPlugin = definePmPlugin({
  id: 'labels',
  permissions: ['manage_categories'],
  hooks: {
    async onIssueCreated(ctx, { issue, input }) {
      if (input.labelIds && input.labelIds.length > 0) {
        await setIssueLabelsImpl(ctx.db, issue.id, input.labelIds);
      }
    },
    async onIssueDetailLoad(ctx, { issue, detail }) {
      detail.labels = await listIssueLabelsImpl(ctx.db, issue.id);
    },
  },
});
