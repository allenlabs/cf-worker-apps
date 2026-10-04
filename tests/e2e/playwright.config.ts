import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Playwright config for end-to-end tests against deployed
 * *.allenlabs.org workers.
 *
 * Design notes:
 *   - Single worker.  The tests share one admin account and write rows that
 *     get cleaned up at teardown — concurrent runs would race on tag-based
 *     teardown.
 *   - Retries=1 because deployed workers occasionally cold-start.
 *   - globalSetup logs in once and writes storageState to .auth/state.json.
 *   - globalTeardown runs cleanup.ts regardless of test outcome.
 *   - HTML report is suppressed (just text on failure) so unattended runs
 *     don't pop a browser.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  globalSetup: path.resolve(__dirname, 'global-setup.ts'),
  globalTeardown: path.resolve(__dirname, 'global-teardown.ts'),
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: 'https://inbox.allenlabs.org',
    storageState: path.resolve(__dirname, '.auth', 'state.json'),
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
