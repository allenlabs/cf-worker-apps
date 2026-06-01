import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';

interface HeaderProps {
  initialQuery?: string;
}

/**
 * Top nav: logo + search box + "New" link.  The search box is a plain GET
 * form so `?q=...` survives a hard reload and shows up in browser history.
 */
export function Header({ initialQuery }: HeaderProps) {
  const { t } = useT();
  const [q, setQ] = useState(initialQuery ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Bind '/' to focus the search box — same key as GitHub/Linear.  Skipped
  // when the user is already typing into an input/textarea.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="border-b border-slate-800 bg-slate-900/70 sticky top-0 z-10" data-testid="header">
      <div className="max-w-3xl mx-auto px-4 py-2 flex items-center gap-3">
        <Link
          to="/"
          className="font-semibold text-stash-300 no-underline hover:no-underline"
          data-testid="header-logo"
        >
          stash
        </Link>
        <form action="/search" method="get" className="flex-1">
          <input
            ref={inputRef}
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('stash.searchPlaceholder')}
            className="w-full rounded bg-slate-800 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-stash-500 focus:outline-none"
            aria-label={t('stash.searchAria')}
            data-testid="header-search"
          />
        </form>
        <Link
          to="/new"
          className="rounded bg-stash-600 hover:bg-stash-500 px-3 py-1.5 text-sm font-medium text-white no-underline hover:no-underline"
          data-testid="header-new"
        >
          {t('stash.new')}
        </Link>
      </div>
    </header>
  );
}
