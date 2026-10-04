import { createFileRoute, redirect } from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import { getEnv } from '~/server/auth-runtime.server';
import {
  clearCookieHeader,
  readSessionToken,
  revokeSession,
} from '~/server/session.server';

export const Route = createFileRoute('/auth/logout')({
  loader: async () => {
    const env = getEnv();
    const req = getRequest();
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    if (token) {
      try {
        await revokeSession(env, token);
      } catch {
        /* Best-effort revoke. */
      }
    }
    const apiSignOut = new URL('/api/auth/sign-out', env.AUTH_API_URL).href;
    throw redirect({
      href: apiSignOut,
      headers: { 'set-cookie': clearCookieHeader() },
    });
  },
});
