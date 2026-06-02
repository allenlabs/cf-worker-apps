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
import { getEnv } from '~/server/auth-runtime.server';
import {
  displayNameOf,
  readSessionToken,
  verifySessionToken,
} from '~/server/session.server';
import appCss from '~/styles/app.css?url';
import { DEFAULT_LOCALE, type Locale } from '@allenlabs/i18n';
import { resolveLocale } from '@allenlabs/i18n/server';
import { I18nProvider } from '@allenlabs/i18n/react';
import { editorDict } from '~/i18n/dict';
import { readThemeFromCookie, type Theme } from '~/lib/theme';

interface AppUser {
  id: string;
  name: string;
}

interface RouterContext {
  user: AppUser | null;
  locale: Locale;
  theme: Theme;
}

/**
 * Paths an unauthenticated visitor must still reach.
 *   /auth/login    starts the SSO redirect
 *   /auth/callback receives the code back
 *   /auth/logout   tears down a session
 *   /favicon.svg   browsers always fetch this first
 */
const PUBLIC_PATHS = new Set(['/auth/login', '/auth/callback', '/auth/logout']);

/**
 * Path prefixes a signed-out visitor must reach. `/share/<id>` backs public
 * read-only share links, so it (like the auth.* routes) bypasses the SSO
 * redirect entirely.
 */
const PUBLIC_PATH_PREFIXES = ['/share/'];

function isPublicPath(pathname: string): boolean {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    // CRITICAL: bail out before touching any *.server.* helper when running on
    // the client — those become non-settling import-protection mock proxies in
    // the client bundle and `await`ing one hangs navigation forever. (See the
    // long-form note this mirrors in project-management's __root.tsx.)
    if (typeof document !== 'undefined') return;

    const req = getRequest();
    if (!req) return;
    const cookie = req.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);

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
    const isPublic = pathname ? isPublicPath(pathname) : false;
    if (token) {
      const env = getEnv();
      const payload = await verifySessionToken(env, token);
      if (payload?.sub) return; // valid session
    }
    if (isPublic) return;
    throw redirect({ to: '/auth/login' });
  },
  loader: async () => {
    // The client-side root loader returns user: null — it can't read the
    // httpOnly JWT. Actions that change the signed-in state use a full-page
    // navigation so SSR re-populates the user. (Mirrors PM.)
    if (typeof document !== 'undefined') {
      return { user: null, appName: 'Editor', locale: DEFAULT_LOCALE, theme: 'light' as Theme };
    }
    const req = getRequest();
    if (!req) return { user: null, appName: 'Editor', locale: DEFAULT_LOCALE, theme: 'light' as Theme };
    const cookie = req.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    const env = getEnv();
    let user: AppUser | null = null;
    let jwtLocale: string | null = null;
    if (token) {
      const payload = await verifySessionToken(env, token);
      if (payload?.sub) {
        user = { id: payload.sub, name: displayNameOf(payload) };
        if (typeof payload.locale === 'string') jwtLocale = payload.locale;
      }
    }
    // Locale priority: cookie → JWT claim → Accept-Language → 'en'. Resolved
    // server-side so the first SSR paint is already in the right language.
    const locale = resolveLocale(req as unknown as Request, jwtLocale);
    const theme = readThemeFromCookie(cookie);
    return { user, appName: env.APP_NAME ?? 'Editor', locale, theme };
  },
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Editor' },
    ],
    links: [
      { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
      { rel: 'stylesheet', href: appCss },
    ],
    // esbuild name-preservation polyfill: TanStack Start's SSR serializer
    // emits inline scripts with `__name(...)` from seroval; without this the
    // first hydration script throws ReferenceError. Injected first.
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
  const appName = data?.appName ?? 'Editor';
  const locale = data?.locale ?? DEFAULT_LOCALE;
  const theme = data?.theme ?? 'light';
  return (
    <RootDocument locale={locale} theme={theme}>
      <I18nProvider locale={locale} dict={editorDict}>
        <Layout user={user} appName={appName} theme={theme}>
          <Outlet />
        </Layout>
      </I18nProvider>
    </RootDocument>
  );
}

function RootDocument({
  locale,
  theme,
  children,
}: {
  locale: Locale;
  theme: Theme;
  children: ReactNode;
}) {
  // Emit the theme class on <html> SSR-side so the very first paint matches the
  // cookie — no light→dark flash on load.
  return (
    <html lang={locale} className={theme === 'dark' ? 'dark' : undefined}>
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
