import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import {
  applyUploadOverlay, captureBuildInputs, clonePreparedCheckout, createArtifactDirectory, digest, exportWorkerArtifact,
  finalizeArtifactManifest, markUploadAttempt, uploadConfigFor, validateModuleImports, validateServicePreservation, verifyArtifactManifest,
} from '../scripts/frozen-artifacts.mjs';
import { runFrozenWrangler, uploadedVersion, uploadVerifiedArtifacts } from '../scripts/upload-verified-artifacts.mjs';

const require = createRequire(import.meta.url);
let esbuild;
try { esbuild = require(process.env.CLOUD_AGENT_OS_ESBUILD_MODULE ?? 'esbuild'); } catch {}

function originalConfig() {
  return {
    name: 'synthetic-workshop', account_id: 'a'.repeat(32), main: 'dist/server.js',
    compatibility_date: '2026-10-01', compatibility_flags: ['nodejs_compat'],
    build: { command: 'must-never-run' }, limits: { cpu_ms: 300_000 }, observability: { enabled: false },
    workers_dev: false, preview_urls: false,
    routes: [{ pattern: 'app.example.invalid', custom_domain: true }],
    vars: { MODE: 'synthetic', ADMINS: ['admin@example.invalid'] },
    services: [{ binding: 'CONTEXT', service: 'synthetic-context', entrypoint: 'Vendor', props: { sharingDomain: 'https://storage.example.invalid' } }],
    durable_objects: { bindings: [{ name: 'STORAGE', class_name: 'Store' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['Store'] }],
    r2_buckets: [{ binding: 'CONTENT', bucket_name: 'synthetic-content' }],
    kv_namespaces: [{ binding: 'CACHE', id: 'b'.repeat(32) }],
    assets: { directory: 'dist/assets', binding: 'ASSETS', html_handling: 'none' },
    rules: [{ type: 'Text', globs: ['**/*.txt'], fallthrough: true }],
  };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'frozen-artifacts-'));
  t.after(async () => {
    const unseal = async directory => { await chmod(directory, 0o700); for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await unseal(join(directory, entry.name)); };
    await unseal(root); await rm(root, { recursive: true, force: true });
  });
  const sourceRoot = join(root, 'source'); await mkdir(sourceRoot);
  await writeFile(join(sourceRoot, 'synthetic.txt'), 'source\n');
  for (const args of [['init', '--quiet'], ['add', '.'], ['-c', 'user.name=Synthetic Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'fixture']]) {
    const result = spawnSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8' }); assert.equal(result.status, 0);
  }
  const configFile = join(root, 'deployment.json'); await writeFile(configFile, JSON.stringify({ account: 'synthetic' }));
  const inputs = await captureBuildInputs({ sourceRoot, configFile });
  const artifactDir = await createArtifactDirectory(join(root, 'artifacts'), [sourceRoot]);
  const modulesDir = join(artifactDir, 'workers', 'workshop', 'modules'); await mkdir(modulesDir, { recursive: true });
  const packageDir = join(root, 'package'); await mkdir(join(packageDir, 'dist', 'assets'), { recursive: true });
  await writeFile(join(packageDir, 'dist', 'assets', 'index.html'), '<p>synthetic</p>');
  await writeFile(join(modulesDir, 'worker.js'), 'globalThis.__pluginWasEvaluated = true; export default {};\n');
  return { root, sourceRoot, configFile, inputs, artifactDir, modulesDir, packageDir };
}
async function manualExport(f) {
  const original = originalConfig(), bytes = await readFile(join(f.modulesDir, 'worker.js'));
  delete original.assets;
  const modules = [{ name: 'worker.js', type: 'ESModule', sha256: digest(bytes), size: bytes.length }];
  const worker = { key: 'workshop', name: original.name, preservedServiceBindings: [], mainModule: 'worker.js', modules, original: 'workers/workshop/original.json', config: 'workers/workshop/upload.json', assets: null };
  await writeFile(join(f.artifactDir, worker.original), JSON.stringify(original));
  await writeFile(join(f.artifactDir, worker.config), JSON.stringify(uploadConfigFor(original, { directory: f.modulesDir, mainModule: 'worker.js', modules })));
  const receipt = await finalizeArtifactManifest({ artifactDir: f.artifactDir, inputs: f.inputs, prepared: { upstream: 'c'.repeat(40), overlayHash: 'd'.repeat(64) }, workers: [worker] });
  return { ...f, manifestDigest: receipt.manifestDigest, worker };
}

test('prebundle relocation preserves every non-packaging setting', () => {
  const original = originalConfig();
  const modules = [{ name: 'worker.js', type: 'ESModule' }, { name: 'prompt.txt', type: 'Text' }, { name: 'icon.svg', type: 'Text' }, { name: 'code.wasm', type: 'CompiledWasm' }];
  const upload = uploadConfigFor(original, { directory: '/private/modules', mainModule: 'worker.js', modules, assetsDirectory: '/private/assets' });
  for (const key of Object.keys(original).filter(key => !['main', 'build', 'rules', 'assets'].includes(key))) assert.deepEqual(upload[key], original[key]);
  assert.equal(upload.build, undefined); assert.equal(upload.no_bundle, true); assert.equal(upload.find_additional_modules, true);
  assert.deepEqual(upload.assets, { ...original.assets, directory: '/private/assets' });
  assert.deepEqual(upload.rules.find(value => value.type === 'Text'), { type: 'Text', globs: ['prompt.txt', 'icon.svg'], fallthrough: false });
});

test('only explicit CPU and observability overlays are accepted', () => {
  const configs = { workshop: originalConfig() };
  const next = applyUploadOverlay(configs, { apiVersion: 1, workers: { workshop: { limits: { cpu_ms: 100_000 }, observability: { enabled: false, logs: { invocation_logs: false } } } } });
  assert.equal(next.workshop.limits.cpu_ms, 100_000); assert.deepEqual(next.workshop.services, configs.workshop.services);
  for (const tuning of [{ routes: [] }, { vars: {} }, { services: [] }, { migrations: [] }, { limits: { cpu_ms: 1, other: true } }, { observability: { enabled: false, other: true } }]) assert.throws(() => applyUploadOverlay(configs, { apiVersion: 1, workers: { workshop: tuning } }), /ARTIFACT_OVERLAY_INVALID/);
});

test('missing Text modules, escaping imports, external packages and stray sidecars fail closed', () => {
  const modules = [{ name: 'worker.js', type: 'ESModule' }, { name: 'prompt.txt', type: 'Text' }];
  assert.doesNotThrow(() => validateModuleImports(modules, 'worker.js', ['./prompt.txt', 'node:buffer', 'buffer', 'cloudflare:workers']));
  assert.throws(() => validateModuleImports([modules[0]], 'worker.js', ['./prompt.txt']), /ARTIFACT_MODULE_MISSING/);
  assert.throws(() => validateModuleImports(modules, 'worker.js', ['../prompt.txt']), /ARTIFACT_MODULE_IMPORT_INVALID/);
  assert.throws(() => validateModuleImports(modules, 'worker.js', ['some-npm-package']), /ARTIFACT_EXTERNAL_IMPORT_UNSUPPORTED/);
  assert.throws(() => validateModuleImports(modules, 'worker.js', []), /ARTIFACT_MODULE_UNREFERENCED/);
});

test('manifest binds checked bytes, configuration and clean source', async t => {
  const f = await manualExport(await fixture(t));
  await verifyArtifactManifest(f);
  await chmod(join(f.modulesDir, 'worker.js'), 0o600);
  await writeFile(join(f.modulesDir, 'worker.js'), 'export default { changed: true };');
  await assert.rejects(verifyArtifactManifest(f), /ARTIFACT_CONFIG_CHANGED/);
});

test('configuration edits after build are rejected before upload', async t => {
  const f = await manualExport(await fixture(t));
  await writeFile(f.configFile, JSON.stringify({ account: 'changed' }));
  let writes = 0;
  await assert.rejects(uploadVerifiedArtifacts({ ...f, attemptMarker: join(f.root, 'attempt'), execute: async () => { writes++; } }), /ARTIFACT_CONFIG_CHANGED/);
  assert.equal(writes, 0);
});

test('source edits after build are rejected', async t => {
  const f = await manualExport(await fixture(t));
  await writeFile(join(f.sourceRoot, 'synthetic.txt'), 'changed');
  await assert.rejects(verifyArtifactManifest(f), /ARTIFACT_SOURCE_NOT_CLEAN/);
});

test('symlink artifacts and unexpected files are rejected', async t => {
  const f = await manualExport(await fixture(t));
  await chmod(f.modulesDir, 0o700);
  await symlink(f.configFile, join(f.modulesDir, 'secret.txt'));
  await assert.rejects(verifyArtifactManifest(f), /ARTIFACT_SYMLINK/);
});

test('upload uses frozen config only and never replays an ambiguous attempt', async t => {
  const f = await manualExport(await fixture(t));
  const attemptMarker = join(f.root, 'attempt'); let writes = 0;
  await assert.rejects(uploadVerifiedArtifacts({ ...f, attemptMarker, execute: async configPath => {
    writes++; const config = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(config.no_bundle, true); assert.equal(config.build, undefined);
    throw new Error('synthetic transport failure');
  } }), /synthetic transport failure/);
  await assert.rejects(uploadVerifiedArtifacts({ ...f, attemptMarker, execute: async () => { writes++; } }), { code: 'EEXIST' });
  assert.equal(writes, 1);
});

test('exclusive durable markers prevent replay', async t => {
  const f = await fixture(t), path = join(f.root, 'attempt');
  await markUploadAttempt(path, { id: 'synthetic' });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { id: 'synthetic' });
  await assert.rejects(markUploadAttempt(path, { id: 'second' }), { code: 'EEXIST' });
});

test('actual parser exports assets and every Text/wasm/data sidecar without evaluating code', { skip: !esbuild && 'Set CLOUD_AGENT_OS_ESBUILD_MODULE to the existing Wrangler esbuild dependency' }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.modulesDir, 'worker.js'), 'import t from "./prompt.txt"; import i from "./icon.svg"; import w from "./code.wasm"; import d from "./data.bin"; globalThis.__pluginWasEvaluated=true; export default {t,i,w,d};');
  for (const name of ['prompt.txt', 'icon.svg', 'code.wasm', 'data.bin']) await writeFile(join(f.modulesDir, name), `synthetic ${name}`);
  const worker = await exportWorkerArtifact({ ...f, key: 'workshop', original: originalConfig(), esbuild });
  assert.equal(globalThis.__pluginWasEvaluated, undefined);
  assert.equal(worker.modules.length, 5);
  const receipt = await finalizeArtifactManifest({ ...f, prepared: { upstream: 'c'.repeat(40), overlayHash: 'd'.repeat(64) }, workers: [worker] });
  const manifest = await verifyArtifactManifest({ ...f, ...receipt });
  assert(manifest.files.some(value => value.file === 'workers/workshop/assets/index.html'));
  const upload = JSON.parse(await readFile(join(f.artifactDir, worker.config), 'utf8'));
  assert.deepEqual(upload.rules.find(value => value.type === 'Text').globs, ['icon.svg', 'prompt.txt']);
});

test('actual parser refuses a missing imported Text module', { skip: !esbuild }, async t => {
  const f = await fixture(t);
  await writeFile(join(f.modulesDir, 'worker.js'), 'import t from "./missing.txt"; export default t;');
  await assert.rejects(exportWorkerArtifact({ ...f, key: 'workshop', original: originalConfig(), esbuild }), /ARTIFACT_MODULE_MISSING/);
});


test('host inventory copies cannot contaminate the prepared cache or share installed dependencies', async t => {
  const f = await fixture(t);
  const cache = join(f.root, 'prepared', 'cloudflare-os');
  await mkdir(join(cache, 'src'), { recursive: true });
  await mkdir(join(cache, 'node_modules'), { recursive: true });
  await writeFile(join(cache, 'src', 'registry.ts'), 'placeholder');
  await writeFile(join(cache, 'node_modules', 'sentinel'), 'must-not-copy');
  await writeFile(join(dirname(cache), 'prepared.json'), JSON.stringify({ upstream: 'c'.repeat(40), overlayHash: 'd'.repeat(64) }));
  const first = await clonePreparedCheckout({ checkout: cache, parent: f.root });
  const second = await clonePreparedCheckout({ checkout: cache, parent: f.root });
  assert.notEqual(first.checkout, second.checkout);
  assert.deepEqual(await readdir(first.checkout), ['src']);
  await writeFile(join(first.checkout, 'src', 'registry.ts'), 'installed');
  assert.equal(await readFile(join(cache, 'src', 'registry.ts'), 'utf8'), 'placeholder');
  assert.equal(await readFile(join(second.checkout, 'src', 'registry.ts'), 'utf8'), 'placeholder');
});


test('successful upload correlates the exact anchored Wrangler version and returns it by role', async t => {
  const f = await manualExport(await fixture(t));
  const version = '01234567-89ab-cdef-0123-456789abcdef';
  assert.equal(uploadedVersion(`Uploaded synthetic (1s)\nCurrent Version ID: ${version}\n`), version);
  for (const output of ['', `Current Version ID: ${version}\nCurrent Version ID: ${version}\n`, `untrusted prefix Current Version ID: ${version}`, 'Current Version ID: malformed']) assert.throws(() => uploadedVersion(output), /ARTIFACT_UPLOAD_VERSION_UNVERIFIED/);
  const receipt = await uploadVerifiedArtifacts({ ...f, attemptMarker: join(f.root, 'successful-attempt'), execute: async () => version });
  assert.deepEqual(receipt.workerVersions, { workshop: version });
  assert.equal(receipt.accepted, true);
});

test('successful command without a version leaves its attempt blocked', async t => {
  const f = await manualExport(await fixture(t));
  const args = { ...f, attemptMarker: join(f.root, 'missing-version-attempt'), execute: async () => undefined };
  await assert.rejects(uploadVerifiedArtifacts(args), /ARTIFACT_UPLOAD_VERSION_UNVERIFIED/);
  await assert.rejects(uploadVerifiedArtifacts(args), { code: 'EEXIST' });
});

test('isolated source copies preserve relative Text symlinks inside their own project', async t => {
  const f = await fixture(t);
  const cache = join(f.root, 'prepared', 'cloudflare-os');
  await mkdir(join(cache, 'src'), { recursive: true });
  await writeFile(join(cache, 'src', 'binding.d.ts'), 'export interface SyntheticBinding {}');
  await symlink('binding.d.ts', join(cache, 'src', 'binding.txt'));
  await writeFile(join(dirname(cache), 'prepared.json'), JSON.stringify({ upstream: 'c'.repeat(40), overlayHash: 'd'.repeat(64) }));
  const isolated = await clonePreparedCheckout({ checkout: cache, parent: f.root });
  assert.equal(await readlink(join(isolated.checkout, 'src', 'binding.txt')), 'binding.d.ts');
  await writeFile(join(cache, 'src', 'binding.d.ts'), 'changed cache');
  assert.equal(await readFile(join(isolated.checkout, 'src', 'binding.txt'), 'utf8'), 'export interface SyntheticBinding {}');
});

test('fresh clone Text symlinks survive actual capnweb asset copying and Wrangler dry-run', {
  skip: !(process.env.CLOUD_AGENT_OS_CAPNWEB_VALIDATE_CLI && process.env.CLOUD_AGENT_OS_WRANGLER_CLI) && 'Set CLOUD_AGENT_OS_CAPNWEB_VALIDATE_CLI and CLOUD_AGENT_OS_WRANGLER_CLI to run the asset pipeline check.',
}, async t => {
  const f = await fixture(t);
  const cache = join(f.root, 'prepared', 'cloudflare-os');
  await mkdir(join(cache, 'src'), { recursive: true });
  await writeFile(join(dirname(cache), 'prepared.json'), JSON.stringify({ upstream: 'c'.repeat(40), overlayHash: 'd'.repeat(64) }));
  await writeFile(join(cache, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', lib: ['ES2022', 'DOM'], types: [] }, include: ['src'] }));
  await writeFile(join(cache, 'package.json'), '{"type":"module"}');
  await writeFile(join(cache, 'src', 'global.d.ts'), 'declare module "*.txt" { const value: string; export default value; }');
  const names = ['agent-spawner-binding', 'ai-model-binding', 'worktree-binding'];
  for (const [index, name] of names.entries()) {
    await writeFile(join(cache, 'src', `${name}.d.ts`), `export interface SyntheticBinding${index} { value: string; }`);
    await symlink(`${name}.d.ts`, join(cache, 'src', `${name}.txt`));
  }
  await writeFile(join(cache, 'src', 'worker.ts'), names.map((name, index) => `import text${index} from "./${name}.txt";`).join('\n') + '\nexport default { fetch() { return new Response([text0,text1,text2].join("\\n")); } };');
  const isolated = await clonePreparedCheckout({ checkout: cache, parent: f.root });
  const home = join(f.root, 'builder-home'); await mkdir(home);
  const env = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C.UTF-8', WRANGLER_SEND_METRICS: 'false', CI: 'true' };
  const validate = spawnSync(process.execPath, [process.env.CLOUD_AGENT_OS_CAPNWEB_VALIDATE_CLI, 'build', '--out', '.wrangler/validate'], { cwd: isolated.checkout, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(validate.status, 0, validate.stderr + validate.stdout);
  await writeFile(join(isolated.checkout, 'wrangler.json'), JSON.stringify({ name: 'synthetic-text-clone', main: '.wrangler/validate/src/worker.ts', compatibility_date: '2026-10-01', rules: [{ type: 'Text', globs: ['**/*.txt'], fallthrough: false }] }));
  const bundle = join(f.root, 'dry-run');
  const dryRun = spawnSync(process.execPath, [process.env.CLOUD_AGENT_OS_WRANGLER_CLI, 'deploy', '--config', 'wrangler.json', '--dry-run', '--outdir', bundle], { cwd: isolated.checkout, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(dryRun.status, 0, dryRun.stderr + dryRun.stdout);
  assert.equal((await readdir(bundle)).filter(name => name.endsWith('.txt')).length, 3);
  for (const name of names) {
    const copied = join(isolated.checkout, '.wrangler/validate/src', `${name}.txt`);
    assert((await lstat(copied)).isFile());
    assert.equal(await readFile(copied, 'utf8'), await readFile(join(cache, 'src', `${name}.d.ts`), 'utf8'));
  }
});

test('explicit preservation substitutes only exact existing service bindings', () => {
  const original = originalConfig();
  const overlay = { apiVersion: 1, workers: { workshop: { preserveServiceBindings: ['CONTEXT'] } } };
  const result = applyUploadOverlay({ workshop: original }, overlay).workshop;
  assert.deepEqual(result.services, []);
  assert.deepEqual(result.unsafe, { bindings: [{ name: 'CONTEXT', type: 'inherit' }] });
  assert.equal(original.services.length, 1);
  for (const key of Object.keys(original).filter(key => key !== 'services')) assert.deepEqual(result[key], original[key]);
  assert.doesNotThrow(() => validateServicePreservation(result, original.services));
});

test('preservation rejects malformed, unknown, duplicate, non-service and colliding names', () => {
  const apply = (config, names) => applyUploadOverlay({ workshop: config }, { apiVersion: 1, workers: { workshop: { preserveServiceBindings: names } } });
  for (const names of [['CONTEXT', 'CONTEXT'], ['CONTEXT;injection'], [{ name: 'CONTEXT' }], 'CONTEXT', [null]]) assert.throws(() => apply(originalConfig(), names), /ARTIFACT_PRESERVATION_INVALID/);
  for (const name of ['UNKNOWN', 'CACHE', 'CONTENT', 'STORAGE', 'MODE']) assert.throws(() => apply(originalConfig(), [name]), /ARTIFACT_PRESERVATION_SERVICE_MISSING/);
  for (const section of ['vars', 'kv_namespaces', 'durable_objects']) {
    const config = originalConfig();
    if (section === 'vars') config.vars.CONTEXT = 'collision';
    if (section === 'kv_namespaces') config.kv_namespaces.push({ binding: 'CONTEXT', id: 'c'.repeat(32) });
    if (section === 'durable_objects') config.durable_objects.bindings.push({ name: 'CONTEXT', class_name: 'Other' });
    assert.throws(() => apply(config, ['CONTEXT']), /ARTIFACT_PRESERVATION_BINDING_COLLISION/);
  }
  const unsafe = { ...originalConfig(), unsafe: { bindings: [{ name: 'CONTEXT', type: 'plain_text', text: 'collision' }] } };
  assert.throws(() => apply(unsafe, ['CONTEXT']), /ARTIFACT_PRESERVATION_UNSAFE_INVALID/);
  const duplicate = originalConfig(); duplicate.services.push({ ...duplicate.services[0] });
  assert.throws(() => apply(duplicate, ['CONTEXT']), /ARTIFACT_PRESERVATION_SERVICE_MISSING/);
});

test('sealed preservation rejects relabels, version overrides, extra metadata and explicit collisions', () => {
  const original = originalConfig();
  const inherited = applyUploadOverlay({ workshop: original }, { apiVersion: 1, workers: { workshop: { preserveServiceBindings: ['CONTEXT'] } } }).workshop;
  assert.throws(() => validateServicePreservation(inherited, [{ ...original.services[0], binding: 'OTHER' }]), /ARTIFACT_PRESERVATION_UNSAFE_INVALID/);
  for (const field of ['old_name', 'version_id']) {
    const changed = structuredClone(inherited); changed.unsafe.bindings[0][field] = 'synthetic-override';
    assert.throws(() => validateServicePreservation(changed, original.services), /ARTIFACT_PRESERVATION_UNSAFE_INVALID/);
  }
  const metadata = structuredClone(inherited); metadata.unsafe.metadata = { bindings: [] };
  assert.throws(() => validateServicePreservation(metadata, original.services), /ARTIFACT_PRESERVATION_UNSAFE_INVALID/);
  const explicit = structuredClone(inherited); explicit.services = original.services;
  assert.throws(() => validateServicePreservation(explicit, original.services), /ARTIFACT_PRESERVATION_EXPLICIT_COLLISION/);
  assert.throws(() => validateServicePreservation(inherited, []), /ARTIFACT_PRESERVATION_UNRECORDED/);
});

test('artifact records retain the exact original service while native inheritance is hash-bound', { skip: !esbuild }, async t => {
  const f = await fixture(t), original = originalConfig();
  const checked = applyUploadOverlay({ workshop: original }, { apiVersion: 1, workers: { workshop: { preserveServiceBindings: ['CONTEXT'] } } }).workshop;
  const worker = await exportWorkerArtifact({ ...f, key: 'workshop', original: checked, esbuild, preservedServiceBindings: original.services });
  const receipt = await finalizeArtifactManifest({ ...f, prepared: { upstream: 'c'.repeat(40), overlayHash: 'd'.repeat(64) }, workers: [worker] });
  const manifest = await verifyArtifactManifest({ ...f, ...receipt });
  assert.deepEqual(manifest.workers[0].preservedServiceBindings, original.services);
  const upload = JSON.parse(await readFile(join(f.artifactDir, worker.config), 'utf8'));
  assert.deepEqual(upload.unsafe, { bindings: [{ name: 'CONTEXT', type: 'inherit' }] });
  assert.deepEqual(upload.services, []);
  // Even a newly trusted manifest digest cannot authorize a mismatched preservation record.
  manifest.workers[0].preservedServiceBindings[0].binding = 'OTHER';
  const manifestBytes = JSON.stringify(manifest);
  const file = join(f.artifactDir, 'manifest.json'); await chmod(file, 0o600); await writeFile(file, manifestBytes);
  await assert.rejects(verifyArtifactManifest({ ...f, manifestDigest: digest(manifestBytes) }), /ARTIFACT_PRESERVATION_UNSAFE_INVALID/);
});

test('actual Wrangler dry-run accepts exactly the selected native inherit metadata', { skip: !process.env.CLOUD_AGENT_OS_WRANGLER_CLI }, async t => {
  const f = await fixture(t), home = join(f.root, 'builder-home'); await mkdir(home);
  await writeFile(join(f.packageDir, 'worker.js'), 'export default { fetch() { return new Response("synthetic"); } };');
  const original = { name: 'synthetic-inherited-service', main: 'worker.js', compatibility_date: '2026-10-01', services: [{ binding: 'EXISTING_SERVICE', service: 'synthetic-context', entrypoint: 'Vendor', props: { sharingDomain: 'https://storage.example.invalid' } }] };
  const config = applyUploadOverlay({ workshop: original }, { apiVersion: 1, workers: { workshop: { preserveServiceBindings: ['EXISTING_SERVICE'] } } }).workshop;
  validateServicePreservation(config, original.services);
  await writeFile(join(f.packageDir, 'wrangler.json'), JSON.stringify(config));
  const env = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C.UTF-8', WRANGLER_SEND_METRICS: 'false', CI: 'true' };
  const result = spawnSync(process.execPath, [process.env.CLOUD_AGENT_OS_WRANGLER_CLI, 'deploy', '--config', 'wrangler.json', '--dry-run', '--outdir', join(f.root, 'inherit-bundle')], { cwd: f.packageDir, env, encoding: 'utf8', timeout: 60_000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.deepEqual(config.unsafe.bindings, [{ name: 'EXISTING_SERVICE', type: 'inherit' }]);
  assert.deepEqual(config.services, []);
  assert((await readdir(join(f.root, 'inherit-bundle'))).some(name => name.endsWith('.js')));
});


test('actual Wrangler reads sealed Text modules and frontend assets using separate writable scratch', {
  skip: !esbuild || !process.env.CLOUD_AGENT_OS_WRANGLER_CLI,
}, async t => {
  const f = await fixture(t), home = join(f.root, 'builder-home'); await mkdir(home);
  await writeFile(join(f.modulesDir, 'worker.js'), 'import text from "./prompt.txt"; export default { fetch() { return new Response(text); } };');
  await writeFile(join(f.modulesDir, 'prompt.txt'), 'synthetic sealed Text module');
  const original = { name: 'synthetic-sealed-worker', main: 'dist/server.js', compatibility_date: '2026-10-01',
    assets: { directory: 'dist/assets', binding: 'ASSETS' } };
  const worker = await exportWorkerArtifact({ ...f, key: 'workshop', original, esbuild });
  const receipt = await finalizeArtifactManifest({ ...f, prepared: { upstream: 'c'.repeat(40), overlayHash: 'd'.repeat(64) }, workers: [worker] });
  const configPath = join(f.artifactDir, worker.config);
  assert.equal((await lstat(dirname(configPath))).mode & 0o777, 0o500);
  const env = { PATH: process.env.PATH ?? '', HOME: home, XDG_CONFIG_HOME: home, LANG: 'C.UTF-8', WRANGLER_SEND_METRICS: 'false', CI: 'true' };
  const stdout = await runFrozenWrangler({ wranglerFile: process.env.CLOUD_AGENT_OS_WRANGLER_CLI, configPath, env,
    dryRun: true, temporaryRoot: f.root });
  assert.match(stdout, /dry.run/i);
  assert.equal((await lstat(dirname(configPath))).mode & 0o777, 0o500);
  assert.deepEqual((await readdir(f.root)).filter(name => name.startsWith('cloud-agent-os-upload-')), []);
  // Exact hashes and file inventory prove no writable caches or other files entered the artifact.
  await verifyArtifactManifest({ ...f, ...receipt });
});
