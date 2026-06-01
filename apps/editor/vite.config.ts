import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const APP_DIR = 'workers/web/app';

// We DON'T use @cloudflare/vite-plugin — its parallel worker env ships a stub
// `getServerFnById` that 500s every POST /_serverFn/<hash>. TanStack Start's
// own dist/server/server.js is the complete worker (full server-fn registry +
// SSR router); we deploy that directly. We only re-inject the `__name` esbuild
// helper as a banner so the worker boots clean on workerd. (Mirrors PM.)
export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: APP_DIR,
      importProtection: { behavior: 'mock' },
    }),
    {
      name: 'editor-cf-worker-polyfills',
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
