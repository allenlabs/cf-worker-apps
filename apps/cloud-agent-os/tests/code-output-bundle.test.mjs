import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require(process.env.CLOUD_AGENT_OS_ESBUILD_MODULE ?? 'esbuild'); }
catch (error) { if (process.env.CLOUD_AGENT_OS_ESBUILD_MODULE) throw error; }
const requiresBuilder = { skip: !esbuild && 'Set CLOUD_AGENT_OS_ESBUILD_MODULE to the installed Wrangler esbuild dependency.' };
const entryPoint = fileURLToPath(new URL('../overlay/packages/workshop-backend/src/code-output.ts', import.meta.url));

function evaluate(code) {
  const module = { exports: {} };
  const context = vm.createContext({
    module, exports: module.exports, TextEncoder,
    console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
  });
  vm.runInContext(code, context);
  return { context, exports: module.exports };
}

for (const keepNames of [false, true]) for (const minify of [false, true]) {
  test(`child code-output module is self-contained after bundling (keepNames=${keepNames}, minify=${minify})`, requiresBuilder, async () => {
    // Wrangler's deployment bundler targets es2024 and defaults keepNames to true. Bundle the
    // real generator, then execute its generated child module in a separate global context.
    const bundled = await esbuild.build({
      entryPoints: [entryPoint], bundle: true, format: 'esm', platform: 'neutral',
      target: 'es2024', keepNames, minify, write: false, loader: { '.txt': 'text' }, logLevel: 'silent',
    });
    const parentCode = (await esbuild.transform(bundled.outputFiles[0].text, { format: 'cjs', target: 'es2024', keepNames: false })).code;
    const parent = evaluate(parentCode).exports;
    const source = parent.codeOutputModuleSource({ mirror: false });
    // Only lower ESM exports for node:vm; do not inject function-name helpers into the child.
    const childCode = (await esbuild.transform(source, { format: 'cjs', target: 'es2024', keepNames: false })).code;
    const child = evaluate(childCode);
    child.context.output = child.exports.output;
    const result = await vm.runInContext(`output.run(() => {
      console.info('module initialization');
      const value = { z: 2, a: 1 };
      console.log(value);
      value.a = 99;
      console.log('x'.repeat(320000));
      return 'RETURN-END';
    })`, child.context);
    assert.equal(result.error, undefined);
    assert.equal(result.output, 'module initialization\n{"a":1,"z":2}\n' + 'x'.repeat(320000) + '\nReturn value: RETURN-END');

    const failedChild = evaluate(childCode);
    failedChild.context.output = failedChild.exports.output;
    const failed = await vm.runInContext(`output.run(() => {
      console.log('accepted before error');
      const context = output.context({ waitUntil() {}, bound() { return this; } });
      context.waitUntil(Promise.resolve().then(() => {
        console.warn('background original');
        throw new Error('Background failure');
      }));
      throw new Error('Foreground failure');
    })`, failedChild.context);
    assert.equal(failed.output, 'accepted before error\nbackground original');
    assert.match(failed.error, /Foreground failure/);
    assert.match(failed.error, /Background failure/);
    assert.match(failed.error, /do not automatically repeat/);
  });
}
