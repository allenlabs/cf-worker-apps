import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRouteWithContext,
  redirect,
} from '@tanstack/react-router';
import { getRequest } from '@tanstack/react-start/server';
import { type QueryClient } from '@tanstack/react-query';
import { ReactNode } from 'react';
import { getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import appCss from '~/styles/app.css?url';
import { DEFAULT_LOCALE, type Locale } from '@allenlabs/i18n';
import { resolveLocale } from '@allenlabs/i18n/server';
import { I18nProvider, useT } from '@allenlabs/i18n/react';
import { hubDict } from '~/i18n/dict';
import { LanguagePicker } from '~/i18n/picker';

interface HubUser {
  id: number;
  login: string;
  isAdmin: boolean;
}

interface RouterContext {
  queryClient: QueryClient;
  user: HubUser | null;
  appName: string;
  locale: Locale;
}

const PUBLIC_PATHS = new Set([
  '/auth/login',
  '/auth/callback',
  '/auth/logout',
  '/health',
]);

export const Route = createRootRouteWithContext<RouterContext>()({
  beforeLoad: async () => {
    let req: Request | undefined;
    try { req = getRequest(); } catch { return; }
    if (!req) return;
    const cookie = req.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    let url: URL | null = null;
    try { url = new URL(req.url); } catch { url = null; }
    const isPublic = url ? PUBLIC_PATHS.has(url.pathname) : false;
    if (token) {
      const env = getEnv();
      const payload = await verifySessionToken(env, token);
      if (payload?.sub) return;
    }
    if (isPublic) return;
    throw redirect({ to: '/auth/login' });
  },
  loader: async () => {
    let req: Request | undefined;
    try { req = getRequest(); } catch {
      return { user: null, appName: 'Hub', locale: DEFAULT_LOCALE };
    }
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    const env = getEnv();
    let user: HubUser | null = null;
    let jwtLocale: string | null = null;
    if (token) {
      const payload = await verifySessionToken(env, token);
      if (payload?.sub) {
        // Suite-wide display name convention (Phase 3).
        const displayName =
          (typeof payload.preferredName === 'string' && payload.preferredName) ||
          (typeof payload.name === 'string' && payload.name) ||
          (typeof payload.username === 'string' && payload.username) ||
          (typeof payload.email === 'string' && payload.email.split('@')[0]) ||
          'user';
        user = { id: -1, login: displayName, isAdmin: false };
        if (typeof payload.locale === 'string') jwtLocale = payload.locale;
      }
    }
    const locale = req
      ? resolveLocale(req as unknown as Request, jwtLocale)
      : DEFAULT_LOCALE;
    return {
      user,
      appName: env.APP_NAME || 'Hub',
      locale,
    };
  },
  head: () => ({
    links: [{ rel: 'stylesheet', href: appCss }],
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'Hub' },
      { name: 'theme-color', content: '#020617' },
    ],
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
      <I18nProvider locale={locale} dict={hubDict}>
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

export function HubHeader({ appName, user, currentPath }: { appName: string; user: HubUser | null; currentPath: string }) {
  const { t } = useT();
  const userLabel = user ? user.login : t('hub.guest');
  return (
    <header className="border-b border-slate-800 bg-slate-950/80 sticky top-0 z-10 backdrop-blur">
      <div className="max-w-5xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
        <Link to="/" className="text-sm font-semibold text-slate-100">
          {appName}
        </Link>
        <nav className="flex items-center gap-4 text-xs text-slate-400">
          <span data-testid="signed-in-user">{t('hub.signedInAs', { name: userLabel })}</span>
          <LanguagePicker />
          <Link to="/auth/logout" className="hover:text-emerald-300">
            {t('nav.signOut')}
          </Link>
          <a href="/health" className={currentPath === '/health' ? 'text-emerald-300' : ''}>
            {t('hub.health')}
          </a>
        </nav>
      </div>
    </header>
  );
}
