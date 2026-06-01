import { Link } from '@tanstack/react-router';
import { useT } from '@allenlabs/i18n/react';

export function Header() {
  const { t } = useT();
  return (
    <header className="border-b border-slate-800 bg-slate-900/70 sticky top-0 z-10" data-testid="header">
      <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-3">
        <Link
          to="/"
          className="font-semibold text-dopamine-300 no-underline hover:no-underline"
          data-testid="header-logo"
        >
          dopamine
        </Link>
        <nav className="flex-1 flex items-center gap-3 text-sm">
          <Link to="/" className="text-slate-300 hover:text-white no-underline" data-testid="nav-recent">
            {t('dopamine.nav.recent')}
          </Link>
          <Link to="/all" className="text-slate-300 hover:text-white no-underline" data-testid="nav-all">
            {t('dopamine.nav.all')}
          </Link>
        </nav>
      </div>
    </header>
  );
}
