import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render as rtlRender, screen } from '@testing-library/react';
import { I18nProvider } from '@allenlabs/i18n/react';
import { appDict } from '~/i18n/dict';
import {
  NotificationsPanel,
  formatTimeOfDay,
  parseTimeOfDay,
} from '~/components/NotificationsPanel';

function render(ui: React.ReactElement) {
  return rtlRender(
    <I18nProvider locale="en" dict={appDict}>
      {ui}
    </I18nProvider>,
  );
}

// ---------- Pure helpers ----------

describe('parseTimeOfDay', () => {
  it('parses valid HH:MM strings', () => {
    expect(parseTimeOfDay('00:00')).toBe(0);
    expect(parseTimeOfDay('09:30')).toBe(9 * 60 + 30);
    expect(parseTimeOfDay('22:00')).toBe(22 * 60);
    expect(parseTimeOfDay('23:59')).toBe(23 * 60 + 59);
    expect(parseTimeOfDay(' 8:15 ')).toBe(8 * 60 + 15);
  });
  it('returns null for blank or malformed input', () => {
    expect(parseTimeOfDay('')).toBeNull();
    expect(parseTimeOfDay('abc')).toBeNull();
    expect(parseTimeOfDay('25:00')).toBeNull();
    expect(parseTimeOfDay('10:99')).toBeNull();
    expect(parseTimeOfDay('10')).toBeNull();
  });
});

describe('formatTimeOfDay', () => {
  it('renders minutes as HH:MM', () => {
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(9 * 60 + 5)).toBe('09:05');
    expect(formatTimeOfDay(23 * 60 + 59)).toBe('23:59');
  });
  it('renders null as the empty string', () => {
    expect(formatTimeOfDay(null)).toBe('');
  });
});

// ---------- Render coverage ----------

describe('NotificationsPanel render', () => {
  // We default to a stripped-down browser env where Notification /
  // PushManager don't exist; the panel should still mount and just show
  // an "unsupported" hint.  Real subscribe flows are exercised in
  // push-client.test.ts; here we only need the wrapping component to
  // wire its state machine and read from <meta name="vapid-public">.

  beforeEach(() => {
    delete (globalThis as { Notification?: unknown }).Notification;
    delete (globalThis as { PushManager?: unknown }).PushManager;
    // Inject a <meta> so the panel exercises the meta-read fallback.
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'vapid-public');
    meta.setAttribute('content', 'YWJj');
    document.head.appendChild(meta);
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn(async () => new Response('null', { status: 500 })),
    });
  });

  afterEach(() => {
    document
      .querySelectorAll('meta[name="vapid-public"]')
      .forEach((el) => el.remove());
    vi.restoreAllMocks();
  });

  it('mounts and shows the unsupported message when PushManager is missing', () => {
    render(<NotificationsPanel />);
    expect(screen.getByTestId('notifications-panel')).toBeTruthy();
    expect(screen.getByTestId('notif-permission').textContent).toBe('unsupported');
    expect(screen.getByText(/Web Push/)).toBeTruthy();
  });

  it('renders the quiet-hours inputs and the on-capture toggle', () => {
    render(<NotificationsPanel />);
    expect(screen.getByLabelText('quiet start')).toBeTruthy();
    expect(screen.getByLabelText('quiet end')).toBeTruthy();
    expect(screen.getByText(/Notify on new captures/)).toBeTruthy();
  });

  it('accepts an explicit vapidPublicKey prop (overrides the <meta>)', () => {
    render(<NotificationsPanel vapidPublicKey="ZGVm" />);
    expect(screen.getByTestId('notifications-panel')).toBeTruthy();
  });

  it('shows the Enable button when push IS supported and permission != granted', async () => {
    // Simulate a browser that has PushManager + Notification with default
    // permission.  We don't drive the real subscribe flow here — just
    // confirm the UI swaps to the "Enable" button branch.
    (globalThis as { Notification?: unknown }).Notification = {
      permission: 'default',
      requestPermission: vi.fn(async () => 'default'),
    };
    (globalThis as { PushManager?: unknown }).PushManager = function PushManager() {};
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: vi.fn(), ready: Promise.resolve(), getRegistration: vi.fn() },
    });
    render(<NotificationsPanel />);
    expect(screen.getByText(/Enable notifications/)).toBeTruthy();
  });

  it('shows the error UI when the subscribe flow throws', async () => {
    const { fireEvent } = await import('@testing-library/react');
    // Wire Notification + PushManager but make serviceWorker.register
    // throw — that triggers the catch in onEnable() which sets `error`.
    (globalThis as { Notification?: unknown }).Notification = {
      permission: 'default',
      requestPermission: vi.fn(async () => 'default'),
    };
    (globalThis as { PushManager?: unknown }).PushManager = function PushManager() {};
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn(async () => { throw new Error('register-explode'); }),
        ready: Promise.resolve(),
        getRegistration: vi.fn(),
      },
    });
    render(<NotificationsPanel />);
    const enable = screen.getByText(/Enable notifications/) as HTMLButtonElement;
    fireEvent.click(enable);
    // Wait a tick so the async catch runs.
    await new Promise((r) => setTimeout(r, 5));
    expect(screen.getByTestId('notif-error').textContent).toMatch(/register-explode/);
  });

  it('shows the Disable button when permission is granted', async () => {
    (globalThis as { Notification?: unknown }).Notification = {
      permission: 'granted',
      requestPermission: vi.fn(async () => 'granted'),
    };
    (globalThis as { PushManager?: unknown }).PushManager = function PushManager() {};
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { register: vi.fn(), ready: Promise.resolve(), getRegistration: vi.fn() },
    });
    render(<NotificationsPanel />);
    expect(screen.getByText(/Disable notifications/)).toBeTruthy();
  });

  it('updates local state when the user edits the quiet-hours / on-capture controls', async () => {
    const { fireEvent } = await import('@testing-library/react');
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn(
        async () =>
          new Response(
            JSON.stringify({ userId: 1, onCapture: true, quietStart: null, quietEnd: null }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    });
    render(<NotificationsPanel />);
    const start = screen.getByLabelText('quiet start') as HTMLInputElement;
    const end = screen.getByLabelText('quiet end') as HTMLInputElement;
    const onCapture = screen.getByRole('checkbox') as HTMLInputElement;
    fireEvent.change(start, { target: { value: '22:00' } });
    fireEvent.change(end, { target: { value: '06:00' } });
    fireEvent.click(onCapture);
    expect(start.value).toBe('22:00');
    expect(end.value).toBe('06:00');
  });
});
