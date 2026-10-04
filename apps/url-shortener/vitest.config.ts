import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import path from 'node:path';

const ROOT = path.resolve(__dirname);

export default defineConfig({
  test: {
    globals: true,
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/unit/**/*.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: './src/index.ts',
            miniflare: {
              compatibilityDate: '2026-01-01',
              compatibilityFlags: ['nodejs_compat'],
              kvNamespaces: ['LINKS'],
              bindings: {
                DEFAULT_CODE_LENGTH: '7',
                ADMIN_EMAILS: '',
              },
            },
          }),
        ],
        test: {
          name: 'workers',
          include: ['tests/workers/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', '**/*.d.ts'],
      thresholds: { lines: 100, statements: 100, functions: 100, branches: 100 },
    },
  },
  resolve: { alias: { '~': path.resolve(ROOT, './src') } },
});
