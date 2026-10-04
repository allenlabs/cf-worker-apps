import { createFileRoute, redirect } from '@tanstack/react-router';
import { getEnv } from '~/server/auth-runtime.server';
import { clearCookieHeader } from '~/server/session.server';

/**
 * Logout — clear the local `editor_session` cookie and bounce the user to
 * auth-api's sign-out endpoint so Better Auth clears its cookie too.
 *
 * v1 has no suite-wide revocation list (no D1 binding), so an already-issued
 * JWT keeps working until its natural exp (≤ 8h); clearing the cookie + the
 * auth-api sign-out is sufficient for an interactive logout.
 */
export const Route = createFileRoute('/auth/logout')({
  loader: async () => {
    const env = getEnv();
    const apiSignOut = new URL('/api/auth/sign-out', env.AUTH_API_URL).href;
    throw redirect({
      href: apiSignOut,
      headers: { 'set-cookie': clearCookieHeader() },
    });
  },
});
