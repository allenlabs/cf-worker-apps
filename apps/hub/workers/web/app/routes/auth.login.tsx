import { createFileRoute, redirect } from '@tanstack/react-router';
import { getEnv } from '~/server/auth-runtime.server';

export const Route = createFileRoute('/auth/login')({
  loader: () => {
    const env = getEnv();
    const callback = new URL('/auth/callback', env.PUBLIC_BASE_URL).href;
    const target = new URL('/sign-in', env.AUTH_WEB_URL);
    target.searchParams.set('return_to', callback);
    throw redirect({ href: target.href });
  },
});
