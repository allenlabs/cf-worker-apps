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
// we don't gate them here.  The API worker (context-api.allenlabs.org)
// handles HMAC traffic for CLI/extension — this list is for SSO-cookie
// callers only.
const PUBLIC_PATHS = new Set([
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
]);

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    // `getRequest()` reads from h3's AsyncLocalStorage and THROWS on the
    // client. Catch it and bail out — the initial SSR already gated this
    // isolate; letting the throw escape silently breaks every in-app Link
    // click (URL changes via pushState but the new route never renders).
    let req: Request | undefined;
    try { req = getRequest(); } catch { return; }
    if (!req) return;
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    let url: URL | null = null;
    try { url = new URL(req.url); } catch { url = null; }
    const isPublic = url ? PUBLIC_PATHS.has(url.pathname) : false;
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
    try { req = getRequest(); } catch { return { user: null, appName: 'Context', locale: DEFAULT_LOCALE }; }
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
          id: -1, // see PM/inbox/focus rationale: never used as a real FK
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
      appName: env.APP_NAME ?? 'Context',
      locale,
    };
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Context' },
      { name: 'theme-color', content: '#1f2937' },
    ],
    links: [
      { rel: 'stylesheet', href: appCss },
    ],
    // `__name` polyfill — see PM/inbox/focus __root.tsx for the full
    // rationale.  Without it, TanStack Start's seroval-emitted hydration
    // script throws ReferenceError before the bundle boots.
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
