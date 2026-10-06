import { createApp } from '@cloudflare/worker-bundler';

const cache = new Map();
let compilations = 0;

export default {
  async fetch(request) {
    const { revision, variant } = await request.json();
    if (!/^[a-f0-9]{40}$/.test(revision) || !['a', 'b'].includes(variant)) {
      return new Response('Invalid synthetic fixture', { status: 400 });
    }

    const client = `const label: string = ${JSON.stringify(variant === 'a' ? 'First synthetic screen' : 'Second synthetic screen')};
const React = { createElement(tag: string, props: unknown, ...children: unknown[]) { return { tag, props, children }; } };
export const view = <button data-variant=${JSON.stringify(variant)}>{label}</button>;`;
    const sourceHash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(client)))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const key = `worker-bundler-0.2.5:${revision}:${sourceHash}`;
    let result = cache.get(key);
    const hit = result !== undefined;

    if (!hit) {
      const started = performance.now();
      const app = await createApp({
        files: {
          'src/server.ts': 'export default { fetch() { return new Response("Synthetic server"); } };',
          'src/client.tsx': client,
        },
        server: 'src/server.ts',
        client: 'src/client.tsx',
        jsx: 'transform',
        assets: { '/index.html': '<!doctype html><div id="app"></div><script type="module" src="./client.js"></script>' },
      });
      result = {
        sourceHash,
        code: app.assets['/client.js'],
        html: app.assets['/index.html'],
        mainModule: app.mainModule,
        serverCode: app.modules[app.mainModule],
        bundleMilliseconds: performance.now() - started,
        warnings: app.warnings || [],
      };
      cache.set(key, result);
      compilations++;
    }

    return Response.json({ ...result, key, hit, compilations, runtime: navigator.userAgent });
  }
};
