import { Link } from '@tanstack/react-router';
import { useT } from '@allenlabs/i18n/react';

export function Header() {
  const { t } = useT();
  return (
    <header className="border-b border-slate-800 bg-slate-900/70 sticky top-0 z-10" data-testid="header">
      <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-3">
        <Link
          to="/"
          className="font-semibold text-transition-300 no-underline hover:no-underline"
          data-testid="header-logo"
        >
          transition
        </Link>
        <nav className="flex-1 flex items-center gap-3 text-sm">
          <Link to="/" className="text-slate-300 hover:text-white no-underline" data-testid="nav-recent">
            {t('transition.nav.recent')}
          </Link>
          <Link to="/new" className="text-slate-300 hover:text-white no-underline" data-testid="nav-new">
            {t('transition.nav.new')}
          </Link>
        </nav>
      </div>
    </header>
  );
}
