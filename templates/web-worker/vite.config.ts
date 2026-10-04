// Canonical TanStack Start web-worker vite config. We deliberately do NOT use
// @cloudflare/vite-plugin (its parallel worker env ships a stub server-fn
// resolver → every POST /_serverFn/<hash> 500s). We deploy TanStack Start's own
// dist/server/server.js directly.

import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const APP_DIR = 'workers/web/app';

export default defineConfig({
  // Static files (favicon, etc.) copied verbatim into dist/client. REQUIRED:
  // vite defaults publicDir to <cwd>/public which doesn't exist in this layout,
  // so without this workers/web/public/* never ships and /favicon.svg 404s.
  publicDir: path.resolve(`./${APP_DIR}/../public`),
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: APP_DIR,
      importProtection: { behavior: 'mock' },
    }),
    {
      // Inject the esbuild __name helper as a banner on the server bundle so the
      // worker boots clean on workerd (seroval/JSX class-name preservation).
      name: 'cf-worker-polyfills',
      apply: 'build',
      enforce: 'post',
      config() {
        return {
          environments: {
            server: {
              build: {
                rollupOptions: {
                  output: {
                    banner: `var __name = (target, name) => Object.defineProperty(target, 'name', { value: name, configurable: true });`,
                  },
                },
              },
            },
          },
        };
      },
    },
  ],
  resolve: {
    alias: { '~': path.resolve(`./${APP_DIR}`) },
  },
});
