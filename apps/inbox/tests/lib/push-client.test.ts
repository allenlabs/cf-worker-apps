// Pure-helper tests for push-client.  The browser-only `requestSubscribe`
// / `unsubscribe` / `fetchPreferences` / `savePreferences` paths are also
// exercised here against a stubbed `navigator.serviceWorker` +
// `Notification` + `fetch` so we hit the same coverage line targets the
// rest of the app uses.

// IMPORTANT: this test file is jsdom-flavored because it pokes at
// `document`, `Notification`, `navigator.serviceWorker`, and `atob`/`btoa`.
// vitest.config picks the project by glob — we live under tests/lib but
// need jsdom, so we declare the environment inline.
// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  arrayBufferToBase64Url,
  fetchPreferences,
  getPermissionState,
  isPushSupported,
  requestSubscribe,
  savePreferences,
  unsubscribe,
  urlBase64ToUint8Array,
} from '~/lib/push-client';

// ---------- shared mocks ----------

interface MockSubscription {
  endpoint: string;
  getKey: (name: 'p256dh' | 'auth') => ArrayBuffer | null;
  unsubscribe: () => Promise<void>;
}

function makeBuffer(s: string): ArrayBuffer {
  const enc = new TextEncoder().encode(s);
  return enc.buffer.slice(enc.byteOffset, enc.byteOffset + enc.byteLength) as ArrayBuffer;
}

function setupBrowserPushMocks(opts: {
  permission?: NotificationPermission;
  existingSubscription?: MockSubscription | null;
  subscribeReturns?: MockSubscription;
  fetchOk?: boolean;
} = {}) {
  const permission = opts.permission ?? 'granted';
  const subscribeReturns: MockSubscription =
    opts.subscribeReturns ?? {
      endpoint: 'https://push.example/sub',
      getKey: (n) => makeBuffer(n === 'p256dh' ? 'p256dh-bytes' : 'auth-bytes'),
      unsubscribe: vi.fn(async () => undefined),
    };

  const subscribe = vi.fn(async () => subscribeReturns);
  const getSubscription = vi.fn(async () => opts.existingSubscription ?? null);
  const registration = {
    pushManager: { subscribe, getSubscription },
  };

  const registerSpy = vi.fn(async () => registration);
  const ready = Promise.resolve(registration as unknown as ServiceWorkerRegistration);
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register: registerSpy,
      ready,
      getRegistration: vi.fn(async () => registration),
    },
  });

  // `Notification` lives on globalThis in jsdom-29.
  (globalThis as { Notification?: unknown }).Notification = {
    permission,
    requestPermission: vi.fn(async () => permission),
  };
  (globalThis as { PushManager?: unknown }).PushManager = function PushManager() {};

  const fetchSpy = vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: opts.fetchOk !== false }), {
        status: opts.fetchOk === false ? 500 : 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: fetchSpy,
  });

  return { registerSpy, fetchSpy, subscribe, getSubscription, subscribeReturns };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as { Notification?: unknown }).Notification;
  delete (globalThis as { PushManager?: unknown }).PushManager;
});

// ---------- Pure helpers ----------

describe('urlBase64ToUint8Array / arrayBufferToBase64Url', () => {
  it('round-trips with padding-free strings', () => {
    const original = 'hello world';
    const buf = new TextEncoder().encode(original).buffer.slice(0);
    const enc = arrayBufferToBase64Url(buf as ArrayBuffer);
    expect(enc).not.toContain('=');
    expect(enc).not.toContain('+');
    expect(enc).not.toContain('/');
    const decoded = urlBase64ToUint8Array(enc);
    expect(new TextDecoder().decode(decoded)).toBe(original);
  });

  it('returns "" for a null buffer', () => {
    expect(arrayBufferToBase64Url(null)).toBe('');
  });

  it('pads short input correctly', () => {
    // Three chars normally pad to one =; we should be able to decode round-trip.
    const decoded = urlBase64ToUint8Array('YWJj'); // "abc"
    expect(new TextDecoder().decode(decoded)).toBe('abc');
  });

  it('decodes URL-safe `-` and `_` back to bytes', () => {
    // 0xFF, 0xFE encoded standard-base64 as "//4="; URL-safe variant is "__4".
    const buf = urlBase64ToUint8Array('__4');
    expect(Array.from(buf)).toEqual([0xff, 0xfe]);
  });
});

// ---------- Browser-side coverage ----------

describe('isPushSupported / getPermissionState', () => {
  it('returns true + the current permission when everything is wired', () => {
    setupBrowserPushMocks({ permission: 'default' });
    expect(isPushSupported()).toBe(true);
    expect(getPermissionState()).toBe('default');
  });

  it('returns "unsupported" when PushManager is missing', () => {
    setupBrowserPushMocks();
    delete (globalThis as { PushManager?: unknown }).PushManager;
    expect(isPushSupported()).toBe(false);
    expect(getPermissionState()).toBe('unsupported');
  });
});

describe('requestSubscribe', () => {
  it('registers, requests permission, subscribes, and POSTs the subscription', async () => {
    const { registerSpy, fetchSpy, subscribeReturns } = setupBrowserPushMocks({});
    const out = await requestSubscribe(
      'BJXvWUduy8fbB9HAnT4nYeT0qgN0XiiQ_Sk-oV7TW4P1TQAckvGjcZCHGS72U6Jia7DSCUtLLU3lIJsnsD3vdWQ',
    );
    expect(out.endpoint).toBe(subscribeReturns.endpoint);
    expect(registerSpy).toHaveBeenCalledWith('/sw.js');
    expect(fetchSpy).toHaveBeenCalledWith('/api/push/subscribe', expect.objectContaining({ method: 'POST' }));
    const fetchCallArgs = (fetchSpy.mock.calls[0] as [string, RequestInit])[1];
    const body = JSON.parse(String(fetchCallArgs.body));
    expect(body.endpoint).toBe(subscribeReturns.endpoint);
    expect(typeof body.keys.p256dh).toBe('string');
    expect(typeof body.keys.auth).toBe('string');
  });

  it('throws when push is unsupported', async () => {
    setupBrowserPushMocks();
    delete (globalThis as { PushManager?: unknown }).PushManager;
    await expect(requestSubscribe('YWJj')).rejects.toThrow(/not supported/);
  });

  it('throws when permission is denied', async () => {
    setupBrowserPushMocks({ permission: 'denied' });
    await expect(requestSubscribe('YWJj')).rejects.toThrow(/permission/);
  });

  it('reuses an existing subscription if one is present', async () => {
    const existing: MockSubscription = {
      endpoint: 'https://push.example/existing',
      getKey: () => makeBuffer('zzz'),
      unsubscribe: vi.fn(async () => undefined),
    };
    const { fetchSpy, subscribe } = setupBrowserPushMocks({ existingSubscription: existing });
    const out = await requestSubscribe('YWJj');
    expect(out.endpoint).toBe('https://push.example/existing');
    expect(subscribe).not.toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('throws when the server rejects the subscription POST', async () => {
    setupBrowserPushMocks({ fetchOk: false });
    await expect(requestSubscribe('YWJj')).rejects.toThrow(/POST/);
  });
});

describe('unsubscribe', () => {
  it('is a no-op when unsupported', async () => {
    setupBrowserPushMocks();
    delete (globalThis as { PushManager?: unknown }).PushManager;
    await expect(unsubscribe()).resolves.toBeUndefined();
  });

  it('is a no-op when no registration exists', async () => {
    setupBrowserPushMocks();
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        register: vi.fn(),
        ready: Promise.resolve(),
        getRegistration: vi.fn(async () => undefined),
      },
    });
    await expect(unsubscribe()).resolves.toBeUndefined();
  });

  it('is a no-op when there is no active subscription', async () => {
    setupBrowserPushMocks({ existingSubscription: null });
    await expect(unsubscribe()).resolves.toBeUndefined();
  });

  it('unsubscribes locally + DELETEs server-side', async () => {
    const existing: MockSubscription = {
      endpoint: 'https://push.example/x',
      getKey: () => makeBuffer('a'),
      unsubscribe: vi.fn(async () => undefined),
    };
    const { fetchSpy } = setupBrowserPushMocks({ existingSubscription: existing });
    await unsubscribe();
    expect(existing.unsubscribe).toHaveBeenCalled();
    expect(fetchSpy).toHaveBeenCalledWith('/api/push/subscribe', expect.objectContaining({ method: 'DELETE' }));
  });

  it('swallows DELETE failures', async () => {
    const existing: MockSubscription = {
      endpoint: 'https://push.example/x',
      getKey: () => makeBuffer('a'),
      unsubscribe: vi.fn(async () => undefined),
    };
    setupBrowserPushMocks({ existingSubscription: existing });
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn(async () => { throw new Error('boom'); }),
    });
    await expect(unsubscribe()).resolves.toBeUndefined();
  });
});

describe('fetchPreferences / savePreferences', () => {
  it('fetchPreferences returns null when fetch fails', async () => {
    setupBrowserPushMocks({ fetchOk: false });
    expect(await fetchPreferences()).toBeNull();
  });

  it('fetchPreferences returns the parsed JSON body', async () => {
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
    const p = await fetchPreferences();
    expect(p?.userId).toBe(1);
    expect(p?.onCapture).toBe(true);
  });

  it('savePreferences POSTs the partial body and returns the row', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ userId: 2, onCapture: false, quietStart: 60, quietEnd: 120 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchSpy });
    const out = await savePreferences({ onCapture: false, quietStart: 60, quietEnd: 120 });
    expect(out?.onCapture).toBe(false);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/push/preferences',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('savePreferences returns null on failure', async () => {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: vi.fn(async () => new Response('nope', { status: 500 })),
    });
    expect(await savePreferences({ onCapture: false })).toBeNull();
  });
});

describe('SSR-guarded paths', () => {
  // When `window` is undefined (server-side), the helpers should bail out
  // without throwing.  We can't `delete window` cleanly in jsdom, so we
  // simulate by stashing & restoring it.
  let savedWindow: unknown;
  beforeEach(() => {
    savedWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = savedWindow;
  });

  it('isPushSupported is false without window', () => {
    expect(isPushSupported()).toBe(false);
  });

  it('fetchPreferences returns null without window', async () => {
    expect(await fetchPreferences()).toBeNull();
  });

  it('savePreferences returns null without window', async () => {
    expect(await savePreferences({ onCapture: true })).toBeNull();
  });
});
