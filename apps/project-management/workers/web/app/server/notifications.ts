// Thin TanStack Start server-fn wrappers for in-app notifications. The logic
// lives in @allenlabs/pm-notifications; this file binds the SSR runtime
// (getCurrentUser / getDb / requireUser). Exercised by the wrangler integration
// tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  listNotificationsImpl,
  markAllReadImpl,
  markReadImpl,
} from '@allenlabs/pm-notifications';
import { getCurrentUser, getDb, requireUser } from './auth-runtime.server';

export const listNotifications = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await getCurrentUser();
  if (!me) return [];
  return listNotificationsImpl(getDb(), me.id);
});

export const markNotificationRead = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return markReadImpl(getDb(), data.id, user.id);
  });

export const markAllNotificationsRead = createServerFn({ method: 'POST' }).handler(async () => {
  const user = await requireUser();
  return markAllReadImpl(getDb(), user.id);
});

/* v8 ignore stop */
