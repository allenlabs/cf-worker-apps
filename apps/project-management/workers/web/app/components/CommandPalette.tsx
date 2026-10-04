import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useT } from '@allenlabs/i18n/react';

interface Action {
  key: string;
  label: string;
  run: () => void;
}

/**
 * Global ⌘K / Ctrl-K command palette: quick keyboard-driven navigation +
 * actions. ADHD-friendly — one keystroke to jump anywhere without hunting
 * through the nav. Rendered once from Layout so it's available on every page.
 */
export function CommandPalette() {
  const { t, locale } = useT();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions = useMemo<Action[]>(() => {
    const go = (to: string) => () => {
      setOpen(false);
      navigate({ to });
    };
    const other = locale === 'ko' ? 'en' : 'ko';
    return [
      { key: 'home', label: t('cmdK.actionGoHome'), run: go('/') },
      { key: 'projects', label: t('cmdK.actionGoProjects'), run: go('/projects') },
      { key: 'mypage', label: t('cmdK.actionGoMyPage'), run: go('/my/page') },
      { key: 'newProject', label: t('cmdK.actionNewProject'), run: go('/projects/new') },
      {
        key: 'toggleLang',
        label: t('cmdK.actionToggleLang'),
        run: () => {
          // Mirror the LanguagePicker: suite-wide cookie + full reload.
          if (typeof document !== 'undefined') {
            const maxAge = 365 * 24 * 60 * 60;
            document.cookie = `lang=${other}; Path=/; Domain=.allenlabs.org; Max-Age=${maxAge}; SameSite=Lax; Secure`;
            window.location.reload();
          }
        },
      },
    ];
  }, [t, navigate, locale]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((a) => a.label.toLowerCase().includes(q));
  }, [actions, query]);

  // Global open shortcut (⌘K / Ctrl-K).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Reset + focus when opening.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after the modal paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Clamp the active index when the filtered set shrinks.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!open) return null;

  return (
    <div
      data-testid="command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[15vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-lg rounded-lg bg-white shadow-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          data-testid="cmdk-input"
          className="w-full px-4 py-3 text-sm outline-none border-b border-gray-200"
          placeholder={t('cmdK.placeholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setActive((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((i) => Math.max(i - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              filtered[active]?.run();
            }
          }}
        />
        <ul className="max-h-80 overflow-auto py-1" role="listbox">
          {filtered.length === 0 ? (
            <li className="px-4 py-2 text-sm text-gray-500">{t('state.empty')}</li>
          ) : (
            filtered.map((a, idx) => (
              <li key={a.key}>
                <button
                  type="button"
                  data-testid={`cmdk-action-${a.key}`}
                  className={`w-full text-left px-4 py-2 text-sm ${idx === active ? 'bg-redmine-100 text-redmine-800' : 'hover:bg-gray-100'}`}
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => a.run()}
                >
                  {a.label}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
