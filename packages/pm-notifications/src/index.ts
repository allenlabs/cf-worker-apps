// @allenlabs/pm-notifications — in-app notifications (assignment / @mention /
// watch) for the PM suite. Owns the notification impls + a lifecycle plugin that
// fans issue create/update events out as notifications. Depends only on
// @allenlabs/pm-core.
export * from './server/notifications';
export { notificationsPlugin } from './notifications.plugin';
