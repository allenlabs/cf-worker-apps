import { defineConfig } from 'vitest/config';
import path from 'node:path';

const ROOT = path.resolve(__dirname);

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/unit/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'workers/ingest/index.ts',
        'workers/relay/delivery.ts',
        'shared/**/*.ts',
      ],
      // workers/relay/index.ts imports cloudflare:workers (Workflow
      // entrypoint + queue consumer) — covered by `wrangler dev` smoke
      // testing rather than node-side coverage.  The Hono `app.post(...)`
      // handlers in workers/ingest/index.ts are also exercised end-to-end
      // by wrangler dev; unit tests target the pure helpers they call.
      exclude: ['workers/relay/index.ts', '**/*.d.ts'],
      thresholds: {
        // Pure helpers (buildJob, loadSubscribers, deliverOnce) are 100%.
        // The Hono route bodies in ingest/index.ts pull the file to ~80%.
        lines: 75,
        statements: 75,
        functions: 75,
        branches: 60,
      },
    },
  },
  resolve: { alias: { '~': path.resolve(ROOT) } },
});
