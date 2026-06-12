import { createFileRoute, redirect } from '@tanstack/react-router';
import { getAdapter, getEnv } from '~/server/auth-runtime.server';

/**
 * Entry point for signing in. The auth adapter builds the redirect to the
 * provider's sign-in (carrying our callback URL). Provider specifics live in
 * the adapter (server/auth/adapters/*). Server-side loader so the redirect
 * happens before any React renders.
 */
export const Route = createFileRoute('/auth/login')({
  loader: () => {
    const env = getEnv();
    const { href } = getAdapter(env).loginRedirect(env, {});
    throw redirect({ href });
  },
});
