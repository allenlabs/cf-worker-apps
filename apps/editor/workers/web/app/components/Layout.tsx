import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { LanguagePicker } from '~/i18n/picker';

interface Props {
  user: { id: string; name: string } | null;
  appName: string;
  children: ReactNode;
}

export function Layout({ user, appName, children }: Props) {
  const { t } = useT();
  return (
    <div className="min-h-screen flex flex-col bg-gray-50">
      <header className="bg-editor-700 text-white">
        <div className="max-w-5xl mx-auto px-4 flex items-center gap-4 h-12">
          <Link to="/" className="text-white font-semibold no-underline hover:underline">
            {appName}
          </Link>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <LanguagePicker />
            {user ? (
              <>
                <span className="text-editor-50">{user.name}</span>
                <a href="/auth/logout" className="text-white/90 hover:text-white no-underline">
                  {t('nav.signOut')}
                </a>
              </>
            ) : (
              <a href="/auth/login" className="text-white/90 hover:text-white no-underline">
                {t('nav.signIn')}
              </a>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 py-6">{children}</main>
    </div>
  );
}
