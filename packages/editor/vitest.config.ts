import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Default to node (pure logic tests). Component tests that mount the editor
    // opt into jsdom via a `// @vitest-environment jsdom` directive at the top
    // of the file (e.g. tests/editor-stability.test.tsx).
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
  },
});
