import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          environment: 'node',
          include: ['tests/*.test.js'],
        },
      },
      {
        plugins: [cloudflareTest({
          wrangler: { configPath: './workers/web/wrangler.toml' },
          miniflare: {
            compatibilityFlags: ['nodejs_compat'],
            bindings: {
              INGEST_TOKEN: 'local-test-ingest-0000000000000000000000000000',
              VIEWER_TOKEN: 'local-test-viewer-0000000000000000000000000000',
              DATASET: 'integration-test',
            },
          },
        })],
        test: {
          name: 'workers',
          include: ['tests/workers/**/*.test.js'],
          testTimeout: 15000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/**/*.js'],
      // Floor the imported source's measured baseline to two decimal places.
      // Workerd integration coverage is separate from this Node-only report.
      thresholds: { statements: 76.19, branches: 69.57, functions: 87.17, lines: 75.44 },
    },
  },
});
