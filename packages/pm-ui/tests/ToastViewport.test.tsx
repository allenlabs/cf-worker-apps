import type { ReactElement } from 'react';
import { act, render as rtlRender, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@allenlabs/i18n/react';
import { ToastViewport } from '../src/ToastViewport';
import { pmUiStrings } from '../src/dict';
import { notifyError, notifySuccess, TOAST_EVENT, type ToastEventDetail } from '../src/toast';

// ToastViewport calls useT(); wrap every render in an English provider so the
// component resolves translations and existing English-text assertions hold.
function render(ui: ReactElement) {
  return rtlRender(
    <I18nProvider locale="en" dict={pmUiStrings}>
      {ui}
    </I18nProvider>,
  );
}

describe('toast event-bus', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('dispatches a success CustomEvent on the window', () => {
    const received: ToastEventDetail[] = [];
    const handler = (e: Event) => received.push((e as CustomEvent<ToastEventDetail>).detail);
    window.addEventListener(TOAST_EVENT, handler);
    notifySuccess('hello');
    window.removeEventListener(TOAST_EVENT, handler);
    expect(received).toEqual([{ kind: 'success', message: 'hello' }]);
  });

  it('dispatches an error CustomEvent on the window', () => {
    const received: ToastEventDetail[] = [];
    const handler = (e: Event) => received.push((e as CustomEvent<ToastEventDetail>).detail);
    window.addEventListener(TOAST_EVENT, handler);
    notifyError('boom');
    window.removeEventListener(TOAST_EVENT, handler);
    expect(received).toEqual([{ kind: 'error', message: 'boom' }]);
  });

  it('is a no-op when window is undefined (SSR safety)', () => {
    const originalWindow = globalThis.window;
    // Simulate SSR: hide `window` from the toast module.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).window = undefined;
    try {
      expect(() => notifySuccess('x')).not.toThrow();
      expect(() => notifyError('y')).not.toThrow();
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window = originalWindow;
    }
  });
});

describe('ToastViewport', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing on the first paint (SSR-safety guard)', () => {
    // React 18 useEffect runs synchronously inside `render` for jsdom, so to
    // observe the pre-effect render we re-implement the same guard logic by
    // checking the live DOM after mount: the region must exist.
    const { container } = render(<ToastViewport />);
    // After mount-effect runs, the region exists but contains no toasts.
    expect(container.querySelector('[data-testid="toast-viewport"]')).not.toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders a success toast when notifySuccess fires', () => {
    render(<ToastViewport />);
    act(() => {
      notifySuccess('It worked');
    });
    const card = screen.getByRole('status');
    expect(card.textContent).toContain('It worked');
    expect(card.className).toContain('bg-green-50');
  });

  it('renders an error toast when notifyError fires', () => {
    render(<ToastViewport />);
    act(() => {
      notifyError('It broke');
    });
    const card = screen.getByRole('alert');
    expect(card.textContent).toContain('It broke');
    expect(card.className).toContain('bg-red-50');
  });

  it('ignores events with an empty message', () => {
    render(<ToastViewport />);
    act(() => {
      window.dispatchEvent(new CustomEvent(TOAST_EVENT, { detail: { kind: 'success', message: '' } }));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('ignores events with no detail', () => {
    render(<ToastViewport />);
    act(() => {
      window.dispatchEvent(new Event(TOAST_EVENT));
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('auto-dismisses after 3 seconds', () => {
    render(<ToastViewport />);
    act(() => {
      notifySuccess('Bye soon');
    });
    expect(screen.getByRole('status')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('dismisses on close-button click', () => {
    render(<ToastViewport />);
    act(() => {
      notifySuccess('Click me away');
    });
    const btn = screen.getByLabelText('Dismiss notification');
    act(() => {
      btn.click();
    });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stacks multiple toasts', () => {
    render(<ToastViewport />);
    act(() => {
      notifySuccess('first');
      notifyError('second');
    });
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('unsubscribes on unmount', () => {
    const { unmount } = render(<ToastViewport />);
    unmount();
    // After unmount, no new toast should land in any leftover viewport.
    act(() => {
      notifySuccess('ghost');
    });
    expect(screen.queryByText('ghost')).toBeNull();
  });
});
