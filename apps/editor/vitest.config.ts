import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';

const ROOT = path.resolve(__dirname);
const WEB_APP = path.resolve(ROOT, './workers/web/app');
const API_SRC = path.resolve(ROOT, './workers/api/src');

// Two test projects:
//   • node    — pure-Node unit tests (formula engine, datasource shaping, SQL
//               builders, …). The bulk of the suite.
//   • workers — @cloudflare/vitest-pool-workers integration test driving the
//               WorkspaceDB SQLite Durable Object against REAL miniflare SQLite
//               (Datasource Step 2 proof). Scoped to tests/workers/**.
export default defineConfig({
  resolve: {
    alias: {
      '~': WEB_APP,
      '@api': API_SRC,
    },
  },
  test: {
    globals: true,
    projects: [
      {
        resolve: { alias: { '~': WEB_APP, '@api': API_SRC } },
        test: {
          name: 'node',
          environment: 'node',
          // The workers-pool integration test runs in its own project; keep it
          // out of the node project so it doesn't execute under plain Node.
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/workers/**'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: './workers/api/src/do/test-worker.ts',
            miniflare: {
              compatibilityDate: '2026-01-01',
              compatibilityFlags: ['nodejs_compat'],
              durableObjects: {
                WORKSPACE_DB: { className: 'WorkspaceDB', useSQLite: true },
              },
            },
          }),
        ],
        resolve: { alias: { '~': WEB_APP, '@api': API_SRC } },
        test: {
          name: 'workers',
          include: ['tests/workers/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['workers/api/src/handlers/formula.ts'],
    },
  },
});
