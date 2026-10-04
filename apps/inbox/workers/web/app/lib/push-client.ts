// Browser-side helpers for Web Push.  Pure client code — must not import
// any worker-runtime modules.  All side-effects (`navigator.serviceWorker`,
// `Notification`, `fetch`) are guarded against SSR so the bundle hydrates
// cleanly on the server.

/** Returns true iff the browser actually supports the Push API + SW. */
export function isPushSupported(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

/** Current permission state, or `'unsupported'` when the API is missing. */
export function getPermissionState(): NotificationPermission | 'unsupported' {
  if (!isPushSupported()) return 'unsupported';
  return Notification.permission;
}

/** Decode a base64url-encoded VAPID public key into the Uint8Array form
 *  `PushManager.subscribe` requires.  Exported so tests can verify the
 *  encoding round-trips. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Inverse of `urlBase64ToUint8Array`.  Used to serialise the
 *  PushSubscription keys (p256dh, auth) before POSTing them. */
export function arrayBufferToBase64Url(buf: ArrayBuffer | null): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i] ?? 0);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Full request → subscribe → POST flow.  Registers `/sw.js` (idempotent),
 * prompts for permission if needed, then calls `pushManager.subscribe`
 * and POSTs the result.  Returns the subscription endpoint on success,
 * or throws with a user-readable message on failure.
 */
export async function requestSubscribe(vapidPublicKey: string): Promise<{
  endpoint: string;
}> {
  if (!isPushSupported()) throw new Error('Push notifications are not supported in this browser.');

  const registration = await navigator.serviceWorker.register('/sw.js');
  // Make sure the SW is active before we touch pushManager.
  await navigator.serviceWorker.ready;

  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(`Notification permission was ${perm}.`);
  }

  let sub = await registration.pushManager.getSubscription();
  if (!sub) {
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
    });
  }

  const p256dh = arrayBufferToBase64Url(sub.getKey('p256dh'));
  const auth = arrayBufferToBase64Url(sub.getKey('auth'));
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh, auth } }),
  });
  if (!res.ok) {
    throw new Error(`POST /api/push/subscribe failed: ${res.status}`);
  }
  return { endpoint: sub.endpoint };
}

/** Unsubscribe locally + DELETE the server-side row.  Errors are swallowed
 *  so a partial failure (e.g. transient 5xx) doesn't lock the user into a
 *  half-state — the next subscribe cycle will rebuild the row. */
export async function unsubscribe(): Promise<void> {
  if (!isPushSupported()) return;
  const registration = await navigator.serviceWorker.getRegistration('/sw.js');
  if (!registration) return;
  const sub = await registration.pushManager.getSubscription();
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe();
  try {
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    });
  } catch (_err) {
    // Server-side row will be cleaned up on the next failed delivery.
  }
}

export interface PushPreferencesShape {
  userId: number;
  onCapture: boolean;
  quietStart: number | null;
  quietEnd: number | null;
}

export async function fetchPreferences(): Promise<PushPreferencesShape | null> {
  if (typeof window === 'undefined') return null;
  const res = await fetch('/api/push/preferences', { credentials: 'same-origin' });
  if (!res.ok) return null;
  return (await res.json()) as PushPreferencesShape;
}

export async function savePreferences(
  input: Partial<Omit<PushPreferencesShape, 'userId'>>,
): Promise<PushPreferencesShape | null> {
  if (typeof window === 'undefined') return null;
  const res = await fetch('/api/push/preferences', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) return null;
  return (await res.json()) as PushPreferencesShape;
}
