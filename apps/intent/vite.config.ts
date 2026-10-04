import { defineConfig } from 'vite';
import { tanstackStart } from '@tanstack/react-start/plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import path from 'node:path';

const APP_DIR = 'workers/web/app';

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({
      srcDirectory: APP_DIR,
      importProtection: { behavior: 'mock' },
    }),
    {
      name: 'intent-cf-worker-polyfills',
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
