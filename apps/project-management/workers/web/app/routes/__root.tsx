import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  redirect,
} from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import type { ReactNode } from 'react';
import { Layout } from '~/components/Layout';
import { getAdapter, getEnv } from '~/server/auth-runtime.server';
import { isStaticAssetPath } from '~/lib/public-paths';
import appCss from '~/styles/app.css?url';
import { DEFAULT_LOCALE, type Locale } from '@allenlabs/i18n';
import { resolveLocale } from '@allenlabs/i18n/server';
import { I18nProvider } from '@allenlabs/i18n/react';
import { pmDict } from '~/i18n/dict';

interface RouterContext {
  user: { id: number; login: string; isAdmin: boolean } | null;
  locale: Locale;
}

/**
 * Paths that an unauthenticated visitor must still be able to reach.
 *   /auth/login        starts the SSO redirect
 *   /auth/callback     receives the code back
 *   /auth/logout       tears down a session
 *   /api/notion-webhook server-side webhook from the notion-gateway —
 *                      auth is HMAC, not session
 *   /favicon.svg       browsers always fetch this first
 */
const PUBLIC_PATHS = new Set([
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/api/notion-webhook',
]);

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    // Server-only auth gate. MUST bail out before touching any server-only
    // helper when running on the client.
    //
    // This `beforeLoad` runs on BOTH the server (SSR) and the client (every
    // in-app <Link> navigation). The server-only helpers it uses —
    // `getRequest`/`getEnv` (from auth-runtime.server) and
    // `verifySessionToken` (from session.server) — are matched by the vite
    // build's `**/*.server.*` import-protection. We run that protection with
    // `behavior: 'mock'`, so in the CLIENT bundle these imports are replaced
    // with import-protection *mock proxies*, not the real functions.
    //
    // A mock proxy is a callable object that returns more mock proxies and
    // never throws. The previous version assumed `getRequest()` would THROW
    // on the client ("No StartEvent found in AsyncLocalStorage") and guarded
    // it with try/catch — but the mock does NOT throw, so `req` came back
    // truthy and execution fell through to `await verifySessionToken(...)`,
    // i.e. `await <mock proxy>`, which never settles. That hung the root
    // `beforeLoad` forever: `loadMatches` awaited it, `router.load()` never
    // resolved, the matched route's loader never ran, no `/_serverFn` fetch
    // fired, and the new route never rendered. The address bar URL had
    // already changed via `pushState`, producing the exact "click does
    // nothing" SPA-navigation bug.
    //
    // The fix: detect the client up front (`typeof document !== 'undefined'`)
    // and return immediately. The auth gate is a server concern only — SSR
    // already gated this isolate, and the JWT lives in an httpOnly cookie the
    // client can't read anyway, so re-verifying on client-side nav is both
    // impossible (no real env/JWKS on the client) and unnecessary.
    if (typeof document !== 'undefined') return;

    // ----- server (SSR) path below -----
    // Fast auth gate: verify the JWT in the cfr_session cookie against JWKS
    // (cached per-isolate, no DB hit). Trust the JWT — if the user was
    // deleted/banned, the JWT will be rejected at its next refresh. Routes
    // that need the actual users row (e.g. /my/page) resolve it in their own
    // data SQL. Saves a Hetzner round-trip (~400 ms) on every page.
    const req = getRequest();
    if (!req) return;
    const cookie = req.headers.get('cookie') ?? null;
    // `req.url` is normally a fully-qualified URL on the worker, but during
    // a server-fn-triggered router invalidation it can be a path-only
    // string or (in some TanStack Start versions) a non-stringable object,
    // which `new URL(...)` rejects with "Invalid URL" or "Cannot convert
    // object to primitive value".  Fall back to extracting the pathname
    // defensively so beforeLoad never throws past the React error boundary.
    let pathname: string | null = null;
    if (req.url != null) {
      try {
        pathname = new URL(req.url as string | URL).pathname;
      } catch {
        try {
          const u = String(req.url);
          const q = u.indexOf('?');
          const trimmed = q >= 0 ? u.slice(0, q) : u;
          pathname = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
        } catch {
          pathname = '/';
        }
      }
    }
    // Static bundles (CSS/JS/fonts/favicon) are public: the worker runs for
    // every path here (CF doesn't auto-serve statics for this app), so without
    // this exemption a lapsed/absent session 307s a stylesheet to /auth/login
    // and the page renders unstyled — the "graphics sometimes break" bug.
    const isPublic = pathname
      ? PUBLIC_PATHS.has(pathname) || isStaticAssetPath(pathname)
      : false;
    if (isPublic) return;
    const env = getEnv();
    // adapter.verify short-circuits on a missing cookie (no JWKS/crypto), so
    // calling it unconditionally keeps the no-cookie path cheap.
    if (await getAdapter(env).verify(env, cookie)) return; // valid session
    throw redirect({ to: '/auth/login' });
  },
  loader: async () => {
    // No DB hit here.  Derive a lightweight "user" object from the JWT
    // claims (sub + email or name) so the layout header can render the
    // current user without paying for the users.findFirst round-trip
    // (~400 ms cold).  Routes that actually need the local users row
    // (`/my/page`, `/admin/users`, etc.) resolve it inline in their
    // own data SQL.
    //
    // Like `beforeLoad`, this runs on both the server and the client. The
    // server-only helpers here become import-protection mock proxies in the
    // client bundle (see the long note in `beforeLoad`), so on client-side
    // nav we MUST bail out before touching them — `await <mock proxy>` never
    // settles. The SSR already filled the layout context on first paint, and
    // the root match is never re-resolved on client nav (TanStack keeps the
    // last-known loader result), so returning a static default is harmless.
    if (typeof document !== 'undefined') {
      return { user: null, appName: 'Project Management', locale: DEFAULT_LOCALE };
    }
    const req = getRequest();
    if (!req) {
      return { user: null, appName: 'Project Management', locale: DEFAULT_LOCALE };
    }
    const cookie = req.headers.get('cookie') ?? null;
    const env = getEnv();
    const identity = await getAdapter(env).verify(env, cookie);
    let user: { id: number; login: string; isAdmin: boolean } | null = null;
    let jwtLocale: string | null = null;
    if (identity) {
      // Suite-wide display convention: preferredName → display name → username →
      // email-local. Sourced from the identity (no DB hit).
      const displayName =
        identity.preferredName ||
        identity.displayName ||
        identity.username ||
        (identity.email ? identity.email.split('@')[0] : '') ||
        'user';
      user = {
        // No local users.id without a DB hit; layout uses this for display
        // only. -1 is a never-stored sentinel so misuse as an FK surfaces.
        id: -1,
        login: displayName,
        // isAdmin requires the DB; default false. Admin pages re-check.
        isAdmin: false,
      };
      jwtLocale = identity.locale ?? null;
    }
    // Locale priority: cookie → JWT claim → Accept-Language → 'en'. resolved
    // server-side so the very first SSR paint is already in the right language
    // (no flash-of-English on a Korean session).
    const locale = resolveLocale(req as unknown as Request, jwtLocale);
    return {
      user,
      appName: env.APP_NAME ?? 'Project Management',
      locale,
    };
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Project Management' },
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'stylesheet', href: appCss },
    ],
    // esbuild's name-preservation helper.  TanStack Start's SSR
    // serializer emits inline scripts riddled with `/* @__PURE__ */
    // __name(...)` from seroval; without the polyfill the very first
    // hydration script throws ReferenceError and the whole page never
    // boots.  Injected as the FIRST head script so it's defined before
    // the seroval barrier runs.
    scripts: [
      {
        children:
          "var __name=(t,n)=>Object.defineProperty(t,'name',{value:n,configurable:true});",
      },
    ],
  }),
  component: RootComponent,
});

function RootComponent() {
  const data = Route.useLoaderData();
  const user = data?.user ?? null;
  const appName = data?.appName ?? 'Project Management';
  const locale = data?.locale ?? DEFAULT_LOCALE;
  return (
    <RootDocument locale={locale}>
      <I18nProvider locale={locale} dict={pmDict}>
        <Layout user={user} appName={appName}>
          <Outlet />
        </Layout>
      </I18nProvider>
    </RootDocument>
  );
}

function RootDocument({
  locale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  return (
    <html lang={locale}>
      <head>
        <HeadContent />
      </head>
      <body>
        <div id="app">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
