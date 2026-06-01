import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';

interface HeaderProps {
  initialQuery?: string;
}

export function Header({ initialQuery }: HeaderProps) {
  const { t } = useT();
  const [q, setQ] = useState(initialQuery ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
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
          className="font-semibold text-solved-300 no-underline hover:no-underline"
          data-testid="header-logo"
        >
          solved
        </Link>
        <form action="/search" method="get" className="flex-1">
          <input
            ref={inputRef}
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('solved.header.searchPlaceholder')}
            className="w-full rounded bg-slate-800 border border-slate-700 px-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-solved-500 focus:outline-none"
            aria-label={t('solved.header.searchLabel')}
            data-testid="header-search"
          />
        </form>
        <Link
          to="/new"
          className="rounded bg-solved-600 hover:bg-solved-500 px-3 py-1.5 text-sm font-medium text-white no-underline hover:no-underline"
          data-testid="header-new"
        >
          {t('solved.header.new')}
        </Link>
      </div>
    </header>
  );
}
