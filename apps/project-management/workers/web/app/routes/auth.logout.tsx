import { createFileRoute, redirect } from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import { getAdapter, getEnv } from '~/server/auth-runtime.server';

/**
 * Logout — the auth adapter revokes the local session (if it keeps one) and
 * returns the post-logout redirect (e.g. the provider's sign-out) plus a
 * clear-cookie header. Provider specifics live in the adapter.
 */
export const Route = createFileRoute('/auth/logout')({
  loader: async () => {
    const env = getEnv();
    const cookie = getRequest()?.headers.get('cookie') ?? null;
    const { href, setCookie } = await getAdapter(env).logout(env, cookie);
    throw redirect({ href, headers: { 'set-cookie': setCookie } });
  },
});
