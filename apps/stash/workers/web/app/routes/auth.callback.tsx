import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';
import { getEnv } from '~/server/auth-runtime.server';
import { cookieHeader, verifySessionToken } from '~/server/session.server';

// Land here after the user signs in on auth.allen.company.  Stash never
// creates a pm.users row — PM's /auth/callback owns that flow.  We just
// stash the JWT in `stash_session` and let the next request use it.

const Search = z.object({
  code: z.string().optional(),
  next: z.string().optional(),
});

export const Route = createFileRoute('/auth/callback')({
  validateSearch: Search,
  loader: async ({ location }) => {
    const env = getEnv();
    const params = Search.parse(location.search);
    const code = params.code;
    if (!code) {
      throw redirect({ to: '/auth/login' });
    }

    const exchangeRes = await fetch(`${env.AUTH_API_URL}/sso/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code,
        client_id: new URL(env.PUBLIC_BASE_URL).origin,
      }),
    });
    if (exchangeRes.status !== 200) {
      const detail = await exchangeRes.text().catch(() => '');
      throw new Response(`Sign-in exchange failed: ${detail.slice(0, 200)}`, { status: 400 });
    }
    const { token } = (await exchangeRes.json()) as { token?: string };
    if (!token) {
      throw new Response('Sign-in exchange returned no token', { status: 500 });
    }

    const payload = await verifySessionToken(env, token);
    if (!payload) {
      throw new Response('Issued JWT failed local verification', { status: 500 });
    }

    const next = params.next && params.next.startsWith('/') ? params.next : '/';
    throw redirect({
      href: next,
      headers: { 'set-cookie': cookieHeader(token) },
    });
  },
});
