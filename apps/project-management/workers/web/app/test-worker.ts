// Minimal HTTP worker used only by the wrangler integration tests in
// `tests/workers/`.  It exercises the runtime auth/session helpers inside a
// real Workers runtime + Miniflare D1 — proof that those code paths work
// end-to-end (cookies, WebCrypto, JOSE JWT verify, JWKS cache, D1 driver).
//
// The TanStack Start `createServerFn` wrappers are NOT mounted here: doing so
// pulls in the TanStack Start SSR runtime, which Vite can only resolve once
// the @tanstack/start-plugin-core Vite plugin has set up `#tanstack-router-entry`.
// For the integration tests we just need to prove the leaf primitives behave.

import { makeDb } from '~/db/client';
import type { Env } from '~/lib/env';
import { findOrCreateUserBySsoImpl, userFromSessionImpl } from '~/server/auth';
import { betterAuthAdapter } from '~/server/auth/adapters/better-auth';
import {
  cookieHeader,
  readSessionToken,
  revokeSession,
  verifySessionToken,
} from '~/server/session.server';

const json = (data: unknown, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const db = makeDb(env);
    const cookie = req.headers.get('cookie');

    if (url.pathname === '/api/whoami' && req.method === 'GET') {
      const me = await userFromSessionImpl(db, betterAuthAdapter, env, cookie);
      return json({ user: me });
    }

    // Test-only: tests post `{ token, sub, email, name }` to seed a session
    // cookie for the rest of the flow.  Production never hits this path —
    // it's behind the test-worker entry which only Miniflare can reach.
    if (url.pathname === '/api/test/sign-in-with-token' && req.method === 'POST') {
      const { token, sub, email, name } = (await req.json()) as {
        token: string;
        sub: string;
        email?: string;
        name?: string;
      };
      await findOrCreateUserBySsoImpl(db, { subject: sub, email: email ?? '', displayName: name });
      return json({ ok: true }, { headers: { 'set-cookie': cookieHeader(token) } });
    }

    if (url.pathname === '/api/sessions/verify' && req.method === 'GET') {
      const token = readSessionToken(cookie);
      if (!token) return json({ valid: false });
      const payload = await verifySessionToken(env, token);
      return json({ valid: !!payload, payload });
    }

    if (url.pathname === '/api/sessions/revoke' && req.method === 'POST') {
      const token = readSessionToken(cookie);
      if (!token) return json({ ok: false });
      await revokeSession(env, token);
      return json({ ok: true });
    }

    if (url.pathname === '/api/r2/put' && req.method === 'POST') {
      const key = url.searchParams.get('key')!;
      const data = await req.arrayBuffer();
      await env.FILES.put(key, data, {
        httpMetadata: { contentType: req.headers.get('content-type') ?? 'text/plain' },
      });
      return json({ ok: true, key, size: data.byteLength });
    }

    if (url.pathname === '/api/r2/get' && req.method === 'GET') {
      const key = url.searchParams.get('key')!;
      const obj = await env.FILES.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      return new Response(await obj.text(), { status: 200 });
    }

    // `/api/kv/*` test endpoints removed alongside the SESSION_KV binding.
    // JWT revocation now lives in the auth D1 (`env.AUTH_DB`) and is exercised
    // via the session-revocation unit tests, not these miniflare helpers.

    return new Response('not found', { status: 404 });
  },
};
