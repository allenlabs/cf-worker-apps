import assert from 'node:assert/strict';
import { mkdtemp, readFile, copyFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const folder = dirname(fileURLToPath(import.meta.url));
const output = await mkdtemp(join(tmpdir(), 'dynamic-ui-check-'));
const bundle = join(output, 'worker.mjs');
const wasm = join(output, 'esbuild.wasm');
let runtime;

try {
  await build({
    entryPoints: [join(folder, 'worker.mjs')], outfile: bundle,
    bundle: true, platform: 'browser', format: 'esm', target: 'es2022', minify: true,
    external: ['*.wasm', 'node:*', 'cloudflare:*'],
  });
  await copyFile(join(dirname(fileURLToPath(import.meta.resolve('@cloudflare/worker-bundler'))), 'esbuild.wasm'), wasm);
  runtime = new Miniflare(convertV4MiniflareOptions({
    modules: [{ type: 'ESModule', path: bundle }, { type: 'CompiledWasm', path: wasm }],
    modulesRoot: output,
    compatibilityDate: '2026-10-01',
  }));

  const run = async (revision, variant = 'a') => {
    const response = await runtime.dispatchFetch('https://fixture.invalid/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ revision, variant }),
    });
    assert.equal(response.status, 200);
    return response.json();
  };

  const started = performance.now();
  const first = await run('a'.repeat(40));
  const firstRequestMilliseconds = performance.now() - started;
  assert.equal(first.runtime, 'Cloudflare-Workers');
  assert.match(first.html, /type="module"/);
  assert.match(first.code, /createElement\("button"/);
  assert.match(first.code, /First synthetic screen/);
  assert.doesNotMatch(first.code, /label: string|tag: string|<button/);
  assert.equal(first.compilations, 1);
  assert.equal(first.hit, false);

  const replay = await run('a'.repeat(40));
  assert.equal(replay.key, first.key);
  assert.equal(replay.code, first.code);
  assert.equal(replay.compilations, 1);
  assert.equal(replay.hit, true);

  const changedSource = await run('a'.repeat(40), 'b');
  assert.notEqual(changedSource.key, first.key);
  assert.match(changedSource.code, /Second synthetic screen/);
  assert.equal(changedSource.compilations, 2);

  const nextRevision = await run('b'.repeat(40), 'b');
  assert.notEqual(nextRevision.key, changedSource.key);
  assert.equal(nextRevision.compilations, 3);

  console.log(JSON.stringify({
    verifiedNativeRuntimeBundle: true,
    packageVersion: '0.2.5', runtime: first.runtime,
    firstRequestMilliseconds: Math.round(firstRequestMilliseconds),
    firstBundleMilliseconds: Math.round(first.bundleMilliseconds),
    workerBundleBytes: (await readFile(bundle)).byteLength,
    wasmBytes: (await readFile(wasm)).byteLength,
    returnedHtmlAndClientJs: true, tsTypesAndJsxRemoved: true,
    replaySkippedCompilation: true, changedSourceUsedNewKey: true, newRevisionUsedNewKey: true,
    warnings: first.warnings,
    scope: 'Synthetic source only; warm memory cache; no Git fetch, browser execution, deployment, persistent cache, or Loader binding.',
  }));
} finally {
  await runtime?.dispose();
  await rm(output, { recursive: true, force: true });
}
