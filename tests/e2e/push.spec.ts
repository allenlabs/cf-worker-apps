/**
 * Push notifications: subscribe → trigger capture → verify push received.
 *
 * Service-worker push delivery is hard to validate in headless Playwright:
 *   - Chromium needs a valid push service registration, which the OS/browser
 *     normally provides.
 *   - The push payload arrives on a service-worker thread (no DOM); the
 *     test would need to message back via `BroadcastChannel` / `postMessage`.
 *   - Cloudflare Workers + VAPID is async — the push is fire-and-forget
 *     via `waitUntil`, so we'd be racing a background queue.
 *
 * Deferred to manual QA for now.  When we have a desktop runner with a
 * real push service, the test should:
 *   1. Grant `notifications` permission via browserContext.grantPermissions.
 *   2. Register a service worker exposing a BroadcastChannel listener for
 *      `push` events.
 *   3. POST /api/capture and wait for the channel message.
 */

import { test } from '@playwright/test';

test.describe('push.subscribe → push.deliver', () => {
  test.skip(true, 'TODO: requires real push service in headless chromium; manual QA only');

  test('subscribe + capture triggers push', async () => {
    // intentionally empty
  });
});
