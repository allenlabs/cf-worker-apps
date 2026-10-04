import { definePmPlugin } from '@allenlabs/pm-core/host/types';
import { dispatchIssueNotificationsImpl } from './server/notifications';

/** Fan issue events out as in-app notifications (assignment / @mention / watch). */
export const notificationsPlugin = definePmPlugin({
  id: 'notifications',
  hooks: {
    async onIssueCreated(ctx, { issue, input }) {
      await dispatchIssueNotificationsImpl(ctx.db, {
        issueId: issue.id,
        actorId: ctx.actingUser!.id,
        newAssigneeId: input.assignedToId ?? null,
        note: input.description,
        notifyWatchers: false,
      });
    },
    async onIssueUpdated(ctx, { before, after, notes }) {
      const assigneeChanged = before.assignedToId !== after.assignedToId;
      await dispatchIssueNotificationsImpl(ctx.db, {
        issueId: after.id,
        actorId: ctx.actingUser!.id,
        newAssigneeId: assigneeChanged ? after.assignedToId : undefined,
        note: notes,
        notifyWatchers: true,
        isComment: notes.length > 0,
      });
    },
  },
});
