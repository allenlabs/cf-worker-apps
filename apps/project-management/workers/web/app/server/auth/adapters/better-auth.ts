// Better Auth adapter — the default `AuthAdapter`. Wraps the existing SSO
// machinery (JWKS verify, /sso/exchange, revoked_sessions, /sso/org/*) behind
// the backend-neutral seam. Fully env-driven: any Better Auth deployment works
// by pointing AUTH_WEB_URL / AUTH_API_URL / PM_ORG_HMAC_* at it. No tenant
// assumptions live here.

import { redirect } from '@tanstack/react-router';
import type { Env } from '~/lib/env';
import {
  clearCookieHeader,
  cookieHeader,
  readSessionToken,
  revokeSession,
  type SessionPayload,
  verifySessionToken,
} from '~/server/session.server';
import { createTeam } from '~/server/org-client';
import type { AuthAdapter, AuthIdentity } from '../types';

/** Map the verified JWT payload to the backend-neutral identity. */
function toIdentity(p: SessionPayload): AuthIdentity {
  return {
    subject: p.sub,
    email: p.email ?? '',
    displayName: p.name ?? null,
    username: p.username ?? null,
    preferredName: p.preferredName ?? null,
    locale: typeof p.locale === 'string' ? p.locale : null,
    isPlatformAdmin: p.role === 'admin',
    teamMemberships: p.teamMemberships ?? [],
  };
}

export const betterAuthAdapter: AuthAdapter = {
  id: 'betterAuth',

  async verify(env, cookie) {
    const token = readSessionToken(cookie);
    if (!token) return null;
    const payload = await verifySessionToken(env, token);
    if (!payload) return null;
    return toIdentity(payload);
  },

  loginRedirect(env, _opts) {
    const callback = new URL('/auth/callback', env.PUBLIC_BASE_URL).href;
    const target = new URL('/sign-in', env.AUTH_WEB_URL);
    target.searchParams.set('return_to', callback);
    return { href: target.href };
  },

  async handleCallback(env, request, deps) {
    const fetchFn = deps?.fetch ?? fetch;
    const url = new URL(request.url);
    const code = url.searchParams.get('code') ?? undefined;
    const nextParam = url.searchParams.get('next') ?? undefined;
    if (!code) throw redirect({ to: '/auth/login' });

    const exchangeRes = await fetchFn(`${env.AUTH_API_URL}/sso/exchange`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, client_id: new URL(env.PUBLIC_BASE_URL).origin }),
    });
    if (exchangeRes.status !== 200) {
      throw new Response('Sign-in exchange failed', { status: 400 });
    }
    const { token } = (await exchangeRes.json()) as { token?: string };
    if (!token) throw new Response('Sign-in exchange returned no token', { status: 500 });
    const payload = await verifySessionToken(env, token);
    if (!payload) throw new Response('Issued JWT failed local verification', { status: 500 });

    const next = nextParam && nextParam.startsWith('/') ? nextParam : '/';
    return { identity: toIdentity(payload), sessionToken: token, redirectTo: next };
  },

  sessionCookie(token) {
    return cookieHeader(token);
  },
  clearSessionCookie() {
    return clearCookieHeader();
  },

  async logout(env, cookie) {
    const token = readSessionToken(cookie);
    if (token) {
      try {
        await revokeSession(env, token);
      } catch {
        // Best-effort: a failed revoke just means the JWT works until its
        // natural expiry. Don't block logout.
      }
    }
    return {
      href: new URL('/api/auth/sign-out', env.AUTH_API_URL).href,
      setCookie: clearCookieHeader(),
    };
  },

  async onProjectCreated(env, ctx) {
    if (!ctx.actingExternalUserId) return { teamId: null };
    try {
      const created = await createTeam(env as Env, {
        actingUserId: ctx.actingExternalUserId,
        name: ctx.projectName,
        slug: ctx.projectSlug,
      });
      return { teamId: created.teamId };
    } catch {
      // Best-effort: the project is still created with pm.members RBAC.
      return { teamId: null };
    }
  },
};
