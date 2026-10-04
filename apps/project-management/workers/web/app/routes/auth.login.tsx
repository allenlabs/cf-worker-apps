import { createFileRoute, redirect } from '@tanstack/react-router';
import { getAdapter, getEnv } from '~/server/auth-runtime.server';

/**
 * Entry point for signing in. The auth adapter builds the redirect to the
 * provider's sign-in (carrying our callback URL). Provider specifics live in
 * the adapter (server/auth/adapters/*). Server-side loader so the redirect
 * happens before any React renders.
 */
export const Route = createFileRoute('/auth/login')({
  loader: async () => {
    const env = getEnv();
    const { href, setCookie } = await getAdapter(env).loginRedirect(env, {});
    // setCookie carries any pre-redirect state the adapter needs at callback
    // (e.g. the OIDC PKCE state/nonce/verifier cookie).
    throw redirect(setCookie ? { href, headers: { 'set-cookie': setCookie } } : { href });
  },
});
