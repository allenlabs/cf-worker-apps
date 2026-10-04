import {
  Outlet,
  createRootRouteWithContext,
  HeadContent,
  Scripts,
  redirect,
} from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import type { QueryClient } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import appCss from '~/styles/app.css?url';
import { DEFAULT_LOCALE, type Locale } from '@allenlabs/i18n';
import { resolveLocale } from '@allenlabs/i18n/server';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import { LanguagePicker } from '~/i18n/picker';

interface RouterContext {
  queryClient: QueryClient;
  user: { id: number; login: string; isAdmin: boolean } | null;
  locale: Locale;
}

// Public paths a signed-out browser must still hit cleanly.  /api/capture
// is HMAC-gated and dispatched in its own server handler; we don't gate it
// here.  The API worker (inbox-api.allenlabs.org) handles HMAC traffic for
// CLI/extension — this list is for SSO-cookie callers only.
const PUBLIC_PATHS = new Set([
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/api/capture',
  // Push endpoints handle auth via the same cookie path as `/`; they're
  // listed here so beforeLoad doesn't redirect XHRs to /auth/login (which
  // would 200-with-HTML and confuse fetch callers).
  '/api/push/subscribe',
  '/api/push/preferences',
  '/manifest.webmanifest',
  '/sw.js',
  '/icon-192.png',
]);

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    // `getRequest()` reads from h3's AsyncLocalStorage and THROWS on the
    // client ("No StartEvent found in AsyncLocalStorage"). Catch it and
    // bail out — the initial SSR already gated this isolate; client-side
    // nav doesn't need to re-verify (the JWT cookie is httpOnly anyway).
    // Letting the throw escape used to silently break every in-app Link
    // click: URL changed via pushState but the new route never rendered
    // because beforeLoad rejected.
    let req: Request | undefined;
    try { req = getRequest(); } catch { return; }
    if (!req) return;
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    // `req.url` is normally a fully-qualified URL on the worker, but during
    // a server-fn-triggered router invalidation it can be a path-only
    // string ("/api/capture"), which `new URL(...)` rejects with
    // "Invalid URL".  Fall back to extracting the pathname manually so a
    // server-fn loop never throws past the React error boundary.
    let pathname: string | null = null;
    if (req?.url) {
      try {
        pathname = new URL(req.url).pathname;
      } catch {
        const u = String(req.url);
        const q = u.indexOf('?');
        const trimmed = q >= 0 ? u.slice(0, q) : u;
        pathname = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
      }
    }
    const isPublic = pathname ? PUBLIC_PATHS.has(pathname) : false;
    if (token) {
      const env = getEnv();
      const payload = await verifySessionToken(env, token);
      if (payload?.sub) return; // valid session
    }
    if (isPublic) return;
    throw redirect({ to: '/auth/login' });
  },
  loader: async () => {
    // Server-only; returns a shape-compatible default on the client so the
    // layout stays rendered if the router ever re-runs the loader after
    // hydration.  See PM/inbox beforeLoad rationale.
    let req: Request | undefined;
    try { req = getRequest(); } catch { return { user: null, appName: 'Inbox', vapidPublicKey: '', locale: DEFAULT_LOCALE }; }
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    const env = getEnv();
    let user: { id: number; login: string; isAdmin: boolean } | null = null;
    let jwtLocale: string | null = null;
    if (token) {
      const payload = await verifySessionToken(env, token);
      if (payload?.sub) {
        const displayName =
          (typeof payload.email === 'string' && payload.email.split('@')[0]) ||
          (typeof payload.name === 'string' && payload.name) ||
          'user';
        user = {
          id: -1, // see PM rationale: never used as a real FK
          login: displayName,
          isAdmin: false,
        };
        if (typeof payload.locale === 'string') jwtLocale = payload.locale;
      }
    }
    const locale = req
      ? resolveLocale(req as unknown as Request, jwtLocale)
      : DEFAULT_LOCALE;
    return {
      user,
      appName: env.APP_NAME ?? 'Inbox',
      // `vapidPublicKey` is the application server key the browser uses
      // to scope its PushSubscription.  Safe to embed in the client
      // bundle / HTML — the corresponding privateKey lives only as a
      // wrangler secret in the worker.
      vapidPublicKey: env.VAPID_PUBLIC_KEY ?? '',
      locale,
    };
  },
  head: ({ loaderData }) => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Inbox' },
      { name: 'theme-color', content: '#1f2937' },
      // `vapid-public` is read by the service worker on
      // `pushsubscriptionchange` to re-subscribe without touching JS
      // state.  Empty string falls back to "no push" cleanly.
      ...(loaderData && typeof loaderData === 'object' && 'vapidPublicKey' in loaderData && typeof (loaderData as { vapidPublicKey: unknown }).vapidPublicKey === 'string'
        ? [{ name: 'vapid-public', content: (loaderData as { vapidPublicKey: string }).vapidPublicKey }]
        : []),
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'stylesheet', href: appCss },
    ],
    // `__name` polyfill — see PM's __root.tsx for the full rationale.
    // Without it, TanStack Start's seroval-emitted hydration script throws
    // ReferenceError before the bundle boots.
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
  const locale = data?.locale ?? DEFAULT_LOCALE;
  return (
    <RootDocument locale={locale}>
      <I18nProvider locale={locale} dict={appDict}>
        <div className="fixed top-2 right-2 z-50">
          <LanguagePicker />
        </div>
        <Outlet />
      </I18nProvider>
    </RootDocument>
  );
}

function RootDocument({ locale, children }: { locale: Locale; children: ReactNode }) {
  return (
    <html lang={locale}>
      <head>
        <HeadContent />
      </head>
      <body className="bg-slate-950 text-slate-100">
        <div id="app">{children}</div>
        <Scripts />
      </body>
    </html>
  );
}
