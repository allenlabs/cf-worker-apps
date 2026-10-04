import { defineConfig } from 'vitest/config';
import path from 'node:path';

const ROOT = path.resolve(__dirname);

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(ROOT, 'shared/src'),
    },
  },
  test: {
    globals: true,
    projects: [
      {
        resolve: {
          alias: { '@shared': path.resolve(ROOT, 'shared/src') },
        },
        test: {
          name: 'node',
          environment: 'node',
          include: [
            'tests/shared/**/*.test.ts',
            'tests/api/**/*.test.ts',
            'tests/web/**/*.test.ts',
          ],
          setupFiles: ['./tests/_setup/setup-node.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      include: [
        'shared/src/**/*.ts',
        'workers/api/src/**/*.ts',
        'workers/web/app/**/*.{ts,tsx}',
      ],
      exclude: [
        // OTel-instrumented entrypoints + framework glue are exercised
        // by deploy smoke tests, not by in-process unit tests.
        'workers/api/src/index.ts',
        'workers/api/src/middleware/telemetry.ts',
        'workers/web/app/server.ts',
        'workers/web/app/lib/env.ts',
        // Drizzle pgSchema/table builders generate runtime objects
        // whose internals show up as "uncovered functions" — they're
        // exercised by every handler test, just opaquely.
        'shared/src/db/schema.ts',
        'shared/src/db/client.ts',
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
