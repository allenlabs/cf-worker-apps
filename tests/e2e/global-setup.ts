/**
 * Playwright global-setup: harvest one SSO session per app domain and
 * write a single storage-state JSON the specs can reuse.
 *
 * The storage state contains the per-app session cookies
 * (inbox_session, focus_session, today_session, context_session).
 * Playwright loads it before every test via `use.storageState` in
 * playwright.config.ts.
 */

import { buildStorageState } from './lib/session';

export default async function globalSetup(): Promise<void> {
  const path = await buildStorageState();
  // eslint-disable-next-line no-console
  console.log(`[e2e:setup] storage state ready at ${path}`);
}
