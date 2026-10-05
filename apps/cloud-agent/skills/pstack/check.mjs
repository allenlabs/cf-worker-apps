import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'implementation-root': { type: 'string' } } });
assert(values['implementation-root'], 'Pass --implementation-root with the Cloud Agent directory containing package.json and workers/pi/admin.js');
const implementation = resolve(values['implementation-root']);
const require = createRequire(resolve(implementation, 'package.json'));
const { build } = require('esbuild');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

const directory = dirname(fileURLToPath(import.meta.url));
const scratch = resolve(directory, 'runtime-check');
await mkdir(scratch, { recursive: true });
const entry = resolve(scratch, 'entry.js');
const bundle = resolve(scratch, 'worker.js');
const source = resolve(implementation, 'workers/pi/admin.js');
await writeFile(entry, `import { ManagementCredentials } from ${JSON.stringify(source)};
export default {fetch(request,env){return env.Credentials.getByName('pstack-check').fetch(request)}};
export class Credentials extends ManagementCredentials {
 async adminSession(){return{csrf:'fixture-csrf',principal:{email:'fixture@example.invalid',role:'super_admin'}}}
 async fetch(request){const {action,input}=await request.json();return Response.json(action==='snapshot'?await this.controlSnapshot():await this.adminMutation(action,input,'fixture-session','fixture-csrf'))}
}`);
await build({ entryPoints: [entry], outfile: bundle, bundle: true, format: 'esm', platform: 'browser', target: 'es2022', external: ['cloudflare:workers'], loader: { '.sql': 'text' } });
let calls = 0;
const mf = new Miniflare(convertV4MiniflareOptions({ name: 'pstack-package-check', modulesRoot: scratch, modules: [{ type: 'ESModule', path: bundle }], compatibilityDate: '2026-10-04', compatibilityFlags: ['nodejs_compat'], durableObjects: { Credentials: { className: 'Credentials', useSQLite: true } }, outboundService: () => { calls++; throw new Error('Network is not allowed'); } }));
const send = async (action, input = {}) => {
  const response = await mf.dispatchFetch('https://pstack.fixture.invalid/check', { method: 'POST', body: JSON.stringify({ action, input }) });
  assert.equal(response.status, 200, await response.clone().text());
  const value = await response.json();
  assert.equal(value.adminError, undefined, JSON.stringify(value));
  return value;
};
try {
  const checked = [];
  for (const name of ['pstack', 'pstack-library']) {
    const payload = JSON.parse(await readFile(resolve(directory, `${name}.payload.json`), 'utf8'));
    const result = await send('skill.validate', payload);
    assert.equal(result.name, name);
    const first = await send('skill.publish', payload);
    const second = await send('skill.publish', payload);
    assert.equal(first.manifestVersion, second.manifestVersion);
    await send('skill.toggle', { name, enabled: true });
    checked.push({ name, bytes: result.bytes, resourceBytes: result.resources.reduce((n, r) => n + r.size, 0), resources: result.resources.length });
  }
  const state = await send('snapshot');
  assert.deepEqual(state.manifest.skills.map(s => s.name), ['pstack', 'pstack-library']);
  for (const skill of state.manifest.skills) {
    const expected = JSON.parse(await readFile(resolve(directory, `${skill.name}.payload.json`), 'utf8'));
    assert.equal(skill.rawContent, expected.rawContent.trim());
    assert.deepEqual(skill.resources.map(r => ({ path: r.path, content: r.content })), expected.resources.map(r => ({ path: r.path, content: r.content })));
  }
  assert.equal(calls, 0);
  const result = { status: 'NOT_INSTALLED', passed: true, nativeValidator: true, nativePublishAndActivation: true, exactResourceRetention: true, idempotentPublish: true, enabledManifestBytes: Buffer.byteLength(JSON.stringify(state.manifest.skills)), checked, networkRequests: calls, inferenceRequests: 0, productionChanges: 0 };
  await writeFile(resolve(directory, 'runtime-check.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await mf.dispose();
  await rm(scratch, { recursive: true, force: true });
}
