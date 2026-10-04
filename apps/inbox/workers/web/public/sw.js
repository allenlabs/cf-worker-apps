// Inbox service worker.  Drives:
//   - the install/activate lifecycle so the PWA is "installable" on iOS/Android
//   - push delivery (showNotification with title/body/tag from the payload)
//   - notification click (focus an existing tab or open one at payload.url)
//   - pushsubscriptionchange (re-subscribe with the same VAPID public key
//     when the browser rotates the subscription)

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Pass-through.  No caching strategy yet; offline-capture-queue lives in
  // its own ticket.
});

// ---- Push delivery -------------------------------------------------------
self.addEventListener('push', (event) => {
  let payload = { title: 'Inbox', body: 'New activity' };
  if (event.data) {
    try {
      payload = event.data.json();
    } catch (_) {
      payload = { title: 'Inbox', body: event.data.text() };
    }
  }
  const title = payload.title || 'Inbox';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'inbox',
    icon: payload.icon || '/icon-192.png',
    badge: payload.badge || '/icon-192.png',
    data: { url: payload.url || (payload.data && payload.data.url) || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// ---- Notification click → focus or open the inbox -----------------------
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of all) {
        // Match by origin so any open inbox tab gets focus.
        if (new URL(client.url).origin === new URL(url, self.location.origin).origin) {
          await client.focus();
          if ('navigate' in client) {
            try { await client.navigate(url); } catch (_) { /* cross-origin or detached */ }
          }
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});

// ---- Re-subscribe on rotation -------------------------------------------
// Browsers occasionally rotate push subscriptions (expiration, GC).  When
// they do, this fires; we re-subscribe with the same VAPID public key the
// SSR HTML embedded in <meta name="vapid-public">, then POST the new
// subscription back to /api/push/subscribe.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        // The application server key is the only thing we need to
        // re-subscribe.  Fetch it from the SSR HTML root document — the
        // root loader embeds <meta name="vapid-public" content="..."> on
        // every page so it's available from the SW's perspective via a
        // plain GET.
        const res = await fetch('/', { credentials: 'same-origin' });
        const html = await res.text();
        const m = html.match(/<meta\s+name="vapid-public"\s+content="([^"]+)"/);
        if (!m) return;
        const vapidPublicKey = m[1];
        const sub = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
        });
        await fetch('/api/push/subscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            endpoint: sub.endpoint,
            keys: {
              p256dh: arrayBufferToBase64Url(sub.getKey('p256dh')),
              auth: arrayBufferToBase64Url(sub.getKey('auth')),
            },
          }),
        });
      } catch (err) {
        // Best-effort; nothing meaningful we can do here besides try
        // again the next time the user opens the app.
        console.error('[sw] pushsubscriptionchange re-subscribe failed', err);
      }
    })(),
  );
});

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = self.atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function arrayBufferToBase64Url(buf) {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return self.btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
