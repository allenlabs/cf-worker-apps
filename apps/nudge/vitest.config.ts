import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const ROOT = path.resolve(__dirname);
const WEB_APP = path.resolve(ROOT, './workers/web/app');
const API_SRC = path.resolve(ROOT, './workers/api/src');

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
        plugins: [react()],
        resolve: { alias: { '~': WEB_APP, '@api': API_SRC } },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'tests/lib/**/*.test.ts',
            'tests/server/**/*.test.ts',
            'tests/api/**/*.test.ts',
            'tests/cron/**/*.test.ts',
          ],
          setupFiles: ['./tests/_setup/setup-node.ts'],
        },
      },
      {
        plugins: [react()],
        resolve: { alias: { '~': WEB_APP, '@api': API_SRC } },
        test: {
          name: 'jsdom',
          environment: 'jsdom',
          include: [
            'tests/components/**/*.test.tsx',
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
        'workers/api/src/**/*.ts',
        'workers/cron/runCron.ts',
      ],
      exclude: [
        'workers/web/app/routeTree.gen.ts',
        'workers/web/app/client.tsx',
        'workers/web/app/server.tsx',
        'workers/web/app/router.tsx',
        'workers/web/app/start.ts',
        'workers/web/app/lib/env.ts',
        'workers/web/app/routes/**',
        'workers/web/app/db/**',
        'workers/web/app/server/auth-runtime.server.ts',
        'workers/api/src/index.ts',
        'workers/api/src/context.ts',
        'workers/api/src/middleware/telemetry.ts',
        'workers/api/src/lib/env.ts',
        'workers/api/src/lib/db.ts',
        '**/*.d.ts',
      ],
      thresholds: {
        lines: 99,
        statements: 99,
        functions: 99,
        branches: 99,
      },
    },
  },
});
