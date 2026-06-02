// Phase 14: light/dark theme toggle in the header. Writes the suite-wide
// `theme` cookie then reloads so SSR re-emits the right <html class> (the
// cookie is the source of truth, read in __root). Mirrors the LanguagePicker.

import { useT } from '@allenlabs/i18n/react';
import { setThemeCookie, type Theme } from '~/lib/theme';

export function ThemeToggle({ theme }: { theme: Theme }) {
  const { t } = useT();
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => {
        setThemeCookie(next);
        if (typeof window !== 'undefined') window.location.reload();
      }}
      className="px-1.5 py-0.5 rounded text-white/70 hover:bg-white/15"
      aria-label={theme === 'dark' ? t('theme.light') : t('theme.dark')}
      title={theme === 'dark' ? t('theme.light') : t('theme.dark')}
      data-testid="theme-toggle"
    >
      {theme === 'dark' ? '☀' : '☾'}
    </button>
  );
}
