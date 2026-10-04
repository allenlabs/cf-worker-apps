import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const APP_DIR = 'workers/web/app';

// Same post-bypass shape as PM / inbox / focus / context: we DON'T use
// @cloudflare/vite-plugin.  Its worker env runs parallel to TanStack Start's
// `server` env and ships a stub `getServerFnById` resolver, so every POST
// /_serverFn/<hash> ends up 500.  TanStack Start's own `dist/server/server.js`
// is the real worker; the only thing we still need is the `__name` esbuild
// helper polyfill, injected as a tiny banner so workerd boots clean.
export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: APP_DIR,
      importProtection: { behavior: 'mock' },
    }),
    {
      name: 'concierge-cf-worker-polyfills',
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
