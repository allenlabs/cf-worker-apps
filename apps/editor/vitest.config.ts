import { defineConfig } from 'vitest/config';
import path from 'node:path';

const ROOT = path.resolve(__dirname);
const WEB_APP = path.resolve(ROOT, './workers/web/app');
const API_SRC = path.resolve(ROOT, './workers/api/src');

// Phase 7 introduces the first unit test suite for the editor app: a pure-Node
// project covering the no-eval formula engine. More projects (jsdom for
// components, workers for D1) can be added later following the inbox app's
// layout.
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
          include: ['tests/**/*.test.ts'],
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
