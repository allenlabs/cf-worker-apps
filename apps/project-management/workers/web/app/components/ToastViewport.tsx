import { useEffect, useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import { TOAST_EVENT, type ToastEventDetail, type ToastKind } from '~/lib/toast';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

const AUTO_DISMISS_MS = 3000;

export function ToastViewport() {
  const { t } = useT();
  const [mounted, setMounted] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    setMounted(true);
    let nextId = 1;
    function onEvent(e: Event) {
      const detail = (e as CustomEvent<ToastEventDetail>).detail;
      if (!detail || !detail.message) return;
      const id = nextId++;
      setToasts((prev) => [...prev, { id, kind: detail.kind, message: detail.message }]);
      window.setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, AUTO_DISMISS_MS);
    }
    window.addEventListener(TOAST_EVENT, onEvent);
    return () => window.removeEventListener(TOAST_EVENT, onEvent);
  }, []);

  // SSR-safety: render nothing until the client mounts so the server-rendered
  // HTML stays empty and there's no hydration mismatch.
  if (!mounted) return null;

  function dismiss(id: number) {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }

  return (
    <div
      role="region"
      aria-label={t('toast.region')}
      data-testid="toast-viewport"
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role={toast.kind === 'error' ? 'alert' : 'status'}
          className={
            'pointer-events-auto flex items-start gap-3 min-w-[16rem] max-w-sm border rounded shadow-md px-3 py-2 text-sm ' +
            'translate-x-0 opacity-100 transition-all duration-200 ' +
            (toast.kind === 'success'
              ? 'border-green-500 bg-green-50 text-green-900'
              : 'border-red-500 bg-red-50 text-red-900')
          }
        >
          <span className="flex-1 break-words">{toast.message}</span>
          <button
            type="button"
            aria-label={t('toast.dismiss')}
            onClick={() => dismiss(toast.id)}
            className="text-current/70 hover:text-current font-bold leading-none"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
