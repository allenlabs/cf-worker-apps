import { definePmPlugin } from '~/host/types';
import { setIssueLabelsImpl } from '~/server/labels';

/** Apply labels chosen at issue creation. */
export const labelsPlugin = definePmPlugin({
  id: 'labels',
  permissions: ['manage_categories'],
  hooks: {
    async onIssueCreated(ctx, { issue, input }) {
      if (input.labelIds && input.labelIds.length > 0) {
        await setIssueLabelsImpl(ctx.db, issue.id, input.labelIds);
      }
    },
  },
});
