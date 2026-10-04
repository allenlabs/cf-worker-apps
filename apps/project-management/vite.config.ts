import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const APP_DIR = 'workers/web/app';

// We DON'T use @cloudflare/vite-plugin.  Its worker env is parallel to
// TanStack Start's `server` env and doesn't receive the server-fn
// resolver virtual module → every POST /_serverFn/<hash> → 500 because
// the worker imports the fake stub from @tanstack/start-server-core
// (`async function getServerFnById(_id, _access) {}`).
//
// TanStack Start's own `dist/server/server.js` is the real, complete
// worker — full server-fn registry + all middleware + the SSR router.
// We deploy that directly.  The only thing cf-vite-plugin gave us that
// we still need is the `__name` esbuild helper polyfill (used in
// JSX class-name preservation in our code OR transitive deps).  Inject
// it as a tiny banner so the worker boots clean on workerd.
export default defineConfig({
  // Static files copied verbatim into dist/client (favicon, etc.). Vite defaults
  // publicDir to <cwd>/public which doesn't exist here, so
  // workers/web/public/favicon.svg never shipped → /favicon.svg 404'd.
  publicDir: path.resolve(`./${APP_DIR}/../public`),
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: APP_DIR,
      importProtection: { behavior: 'mock' },
    }),
    {
      name: 'pm-cf-worker-polyfills',
      apply: 'build',
      enforce: 'post',
      // Inject the polyfill banner ONLY on the server build that produces
      // dist/server/server.js (the file we ship as the worker).
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
