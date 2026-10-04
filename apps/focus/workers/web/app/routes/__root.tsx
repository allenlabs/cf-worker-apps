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

// Public paths a signed-out browser must still hit cleanly.  /api/* routes
// are cookie-or-HMAC-gated and dispatched in their own server handlers;
// we don't gate them here.  The API worker (focus-api.allenlabs.org)
// handles HMAC traffic for CLI/extension — this list is for SSO-cookie
// callers only.
const PUBLIC_PATHS = new Set([
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/api/start',
  '/api/end',
  '/api/distract',
  '/manifest.webmanifest',
  '/sw.js',
]);

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    // `getRequest()` reads from h3's AsyncLocalStorage and THROWS on the
    // client. Catch it and bail out — the initial SSR already gated this
    // isolate; letting the throw escape used to silently break every
    // in-app Link click.
    let req: Request | undefined;
    try { req = getRequest(); } catch { return; }
    if (!req) return;
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    // `req.url` is normally fully-qualified, but during a server-fn-driven
    // router invalidation TanStack Start can hand back a path-only string
    // ("/api/end"), which `new URL(...)` rejects.  Fall back to a manual
    // pathname extract so a server-fn loop never crashes into the React
    // error boundary.
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
    // Server-only — see beforeLoad rationale.  Return a shape-compatible
    // default so the layout keeps rendering on the client.
    let req: Request | undefined;
    try { req = getRequest(); } catch { return { user: null, appName: 'Focus', locale: DEFAULT_LOCALE }; }
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
          id: -1, // see PM/inbox rationale: never used as a real FK
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
      appName: env.APP_NAME ?? 'Focus',
      locale,
    };
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Focus' },
      { name: 'theme-color', content: '#1f2937' },
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'manifest', href: '/manifest.webmanifest' },
      { rel: 'stylesheet', href: appCss },
    ],
    // `__name` polyfill — see PM/inbox __root.tsx for the full rationale.
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
