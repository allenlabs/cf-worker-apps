import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/_setup/setup-node.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      // db/* is the SSR-runtime client (makeDb/buildClient need a live
      // Hyperdrive binding + the TanStack request context), so it's covered
      // by deploy/integration, not in-process unit tests — mirroring the app's
      // own `workers/web/app/db/**` coverage exclusion. The pure retry logic
      // in client.ts is still behaviourally exercised by tests/db/cold-start.
      exclude: ['src/db/**', 'src/testing/**'],
      thresholds: {
        lines: 100,
        statements: 100,
        functions: 100,
        branches: 100,
      },
    },
  },
});
