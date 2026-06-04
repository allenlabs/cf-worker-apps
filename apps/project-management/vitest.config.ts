import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';

const ROOT = path.resolve(__dirname);
const WEB_APP = path.resolve(ROOT, './workers/web/app');

export default defineConfig({
  resolve: {
    alias: { '~': WEB_APP },
  },
  test: {
    globals: true,
    projects: [
      {
        plugins: [react()],
        resolve: { alias: { '~': WEB_APP } },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'tests/lib/**/*.test.ts',
            'tests/server/**/*.test.ts',
            'tests/cleanup/**/*.test.ts',
            'tests/api/**/*.test.ts',
          ],
          setupFiles: ['./tests/_setup/setup-node.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { '~': WEB_APP } },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: ['tests/components/**/*.test.tsx'],
          setupFiles: ['./tests/_setup/setup-jsdom.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: './workers/web/app/test-worker.ts',
            miniflare: {
              compatibilityDate: '2026-01-01',
              compatibilityFlags: ['nodejs_compat'],
              d1Databases: ['DB'],
              kvNamespaces: ['SESSION_KV'],
              r2Buckets: ['FILES'],
              bindings: {
                APP_NAME: 'Project Management (test)',
                DEFAULT_LANGUAGE: 'en',
                AUTH_WEB_URL: 'https://auth.test',
                AUTH_API_URL: 'https://auth-api.test',
                PUBLIC_BASE_URL: 'http://localhost:3000',
                PM_ORG_HMAC_CLIENT_ID: 'pm',
                PM_ORG_HMAC_SECRET: 'test-org-hmac-secret-1234567890abcd',
              },
            },
          }),
        ],
        resolve: { alias: { '~': WEB_APP } },
        test: {
          name: 'workers',
          include: ['tests/workers/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: ['workers/web/app/**/*.{ts,tsx}'],
      exclude: [
        'workers/web/app/routeTree.gen.ts',
        'workers/web/app/client.tsx',
        'workers/web/app/server.tsx',
        'workers/web/app/router.tsx',
        'workers/web/app/start.ts',
        'workers/web/app/test-worker.ts',
        'workers/web/app/lib/env.ts',
        'workers/web/app/routes/**',
        'workers/web/app/db/**',
        // Client-only interaction shells exercised by the top-level Playwright
        // E2E suite, not the in-process node/jsdom unit tests: the ⌘K command
        // palette (global keydown + router navigation) and the suite language
        // picker (document.cookie write + full-page reload). Same category as
        // routes/** and client.tsx above.
        'workers/web/app/components/CommandPalette.tsx',
        'workers/web/app/i18n/picker.tsx',
        // SSR-runtime-only helpers — exercised by deploy integration, not
        // by the in-process unit tests.  Earlier the file was wrapped in
        // `/* v8 ignore start/stop */` markers but vitest/v8 stopped
        // honoring them somewhere along the way, so list it explicitly.
        'workers/web/app/server/auth-runtime.server.ts',
        '**/*.d.ts',
      ],
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
