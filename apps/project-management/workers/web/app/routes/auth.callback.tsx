import { createFileRoute, redirect } from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import { findOrCreateUserBySsoImpl } from '@allenlabs/pm-core/server/auth';
import { getAdapter, getDb, getEnv } from '~/server/auth-runtime.server';

/**
 * Land here after the user completed sign-in at the auth provider. The auth
 * adapter exchanges the callback for a session token + identity; we look up or
 * create the local users row and stash the session cookie before bouncing on.
 * All provider specifics live in the adapter (server/auth/adapters/*).
 */
export const Route = createFileRoute('/auth/callback')({
  loader: async () => {
    const env = getEnv();
    const adapter = getAdapter(env);
    const request = getRequest();
    if (!request) throw redirect({ to: '/auth/login' });
    const { identity, sessionToken, redirectTo } = await adapter.handleCallback(env, request);
    await findOrCreateUserBySsoImpl(getDb(env), identity);
    throw redirect({
      href: redirectTo,
      headers: { 'set-cookie': adapter.sessionCookie(sessionToken) },
    });
  },
});
