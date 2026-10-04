import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const ROOT = path.resolve(__dirname);
const WEB_APP = path.resolve(ROOT, './workers/web/app');

export default defineConfig({
  resolve: {
    alias: {
      '~': WEB_APP,
    },
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
          include: [
            'tests/routes/**/*.test.tsx',
          ],
          setupFiles: ['./tests/_setup/setup-jsdom.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: [
        'workers/web/app/**/*.{ts,tsx}',
      ],
      exclude: [
        'workers/web/app/routeTree.gen.ts',
        'workers/web/app/client.tsx',
        'workers/web/app/server.tsx',
        'workers/web/app/router.tsx',
        'workers/web/app/start.ts',
        'workers/web/app/lib/env.ts',
        // Routes are mostly thin loaders/components covered by deploy
        // smoke tests (inbox/focus convention).  The pure impls behind
        // them live in workers/web/app/server/*.ts which DO need coverage.
        'workers/web/app/routes/**',
        'workers/web/app/db/**',
        'workers/web/app/server/auth-runtime.server.ts',
        '**/*.d.ts',
      ],
      thresholds: {
        // Match the inbox / focus baseline so coverage growth keeps the
        // same discipline as we add features.
        lines: 99,
        statements: 99,
        functions: 99,
        branches: 99,
      },
    },
  },
});
