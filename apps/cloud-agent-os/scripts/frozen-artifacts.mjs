import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, extname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

const MAX_FILES = 100_000;
const MAX_BYTES = 1024 * 1024 * 1024;
const TYPES = { '.js': 'ESModule', '.mjs': 'ESModule', '.txt': 'Text', '.svg': 'Text', '.wasm': 'CompiledWasm', '.bin': 'Data' };
const builtins = new Set(builtinModules.flatMap(name => [name, `node:${name}`]));
export const digest = value => createHash('sha256').update(value).digest('hex');
const check = (value, code) => assert(value, code);
const isDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const outside = (parent, child) => { const path = relative(parent, child); return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path); };
const equal = (a, b) => assert.deepEqual(a, b, 'ARTIFACT_CONFIG_CHANGED');

async function regularFile(file) {
  const info = await lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && info.size <= MAX_BYTES && await realpath(file) === resolve(file), 'ARTIFACT_FILE_INVALID');
  return info;
}
async function walk(root, prefix = '') {
  const files = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
    check(!entry.isSymbolicLink(), 'ARTIFACT_SYMLINK');
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await walk(join(root, entry.name), name));
    else { check(entry.isFile(), 'ARTIFACT_FILE_INVALID'); files.push(name); }
    check(files.length <= MAX_FILES, 'ARTIFACT_FILE_LIMIT');
  }
  return files;
}
function localName(value) {
  check(typeof value === 'string' && value.length > 0 && !isAbsolute(value) && !value.includes('\\') && !value.split('/').some(part => !part || part === '.' || part === '..'), 'ARTIFACT_PATH_INVALID');
  return value;
}
async function fileRecord(root, name) {
  localName(name);
  const file = join(root, name), info = await regularFile(file);
  return { file: name, sha256: digest(await readFile(file)), size: info.size };
}
async function privateJson(file, value) { await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o400, flag: 'wx' }); }

/** Reserve a fresh private destination outside both source and disposable build trees. */
export async function createArtifactDirectory(directory, forbiddenRoots) {
  directory = resolve(directory);
  check(forbiddenRoots.every(root => outside(resolve(root), directory)), 'ARTIFACT_DIRECTORY_INSIDE_SOURCE');
  check(await realpath(dirname(directory)) === dirname(directory), 'ARTIFACT_PARENT_INVALID');
  await mkdir(directory, { mode: 0o700 });
  return directory;
}

/** Host inventory is applied only to a unique disposable copy, never the reusable prepare cache. */
export async function clonePreparedCheckout({ checkout, parent }) {
  check(await realpath(checkout) === resolve(checkout) && await realpath(parent) === resolve(parent), 'ARTIFACT_BUILD_DIRECTORY_INVALID');
  const temporary = await mkdtemp(join(parent, 'checked-source-'));
  const destination = join(temporary, 'cloudflare-os');
  await cp(checkout, destination, { recursive: true, verbatimSymlinks: true, filter: source => !relative(checkout, source).split(sep).includes('node_modules') });
  await copyFile(join(dirname(checkout), 'prepared.json'), join(temporary, 'prepared.json'));
  return { temporary, checkout: destination };
}

/** The only optional target tuning is explicit CPU/observability configuration. */
export function applyUploadOverlay(configs, overlay) {
  if (overlay === undefined) return structuredClone(configs);
  check(overlay && overlay.apiVersion === 1 && Object.keys(overlay).length === 2 && overlay.workers && typeof overlay.workers === 'object' && !Array.isArray(overlay.workers), 'ARTIFACT_OVERLAY_INVALID');
  const result = structuredClone(configs);
  for (const [key, tuning] of Object.entries(overlay.workers)) {
    check(Object.hasOwn(result, key) && tuning && typeof tuning === 'object' && !Array.isArray(tuning) && Object.keys(tuning).every(name => ['limits', 'observability'].includes(name)), 'ARTIFACT_OVERLAY_INVALID');
    if (Object.hasOwn(tuning, 'limits')) {
      check(tuning.limits && Object.keys(tuning.limits).length === 1 && Number.isSafeInteger(tuning.limits.cpu_ms) && tuning.limits.cpu_ms >= 1 && tuning.limits.cpu_ms <= 300_000, 'ARTIFACT_OVERLAY_INVALID');
      result[key].limits = { ...result[key].limits, cpu_ms: tuning.limits.cpu_ms };
    }
    if (Object.hasOwn(tuning, 'observability')) {
      const value = tuning.observability;
      check(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(name => ['enabled', 'head_sampling_rate', 'logs', 'traces'].includes(name)), 'ARTIFACT_OVERLAY_INVALID');
      check(typeof value.enabled === 'boolean', 'ARTIFACT_OVERLAY_INVALID');
      for (const sampling of [value.head_sampling_rate, value.logs?.head_sampling_rate, value.traces?.head_sampling_rate]) check(sampling === undefined || typeof sampling === 'number' && sampling >= 0 && sampling <= 1, 'ARTIFACT_OVERLAY_INVALID');
      for (const name of ['logs', 'traces']) if (value[name] !== undefined) {
        const section = value[name];
        check(section && typeof section === 'object' && !Array.isArray(section) && Object.keys(section).every(field => ['enabled', 'head_sampling_rate', ...(name === 'logs' ? ['invocation_logs'] : [])].includes(field)), 'ARTIFACT_OVERLAY_INVALID');
        for (const field of ['enabled', 'invocation_logs']) check(section[field] === undefined || typeof section[field] === 'boolean', 'ARTIFACT_OVERLAY_INVALID');
      }
      result[key].observability = structuredClone(value);
    }
  }
  return result;
}

/** Parse without executing plugin or application code, using the already installed build tool. */
export async function inspectModuleImports(esbuild, bytes) {
  const result = await esbuild.build({ stdin: { contents: bytes.toString('utf8'), sourcefile: 'checked-worker.js' }, bundle: false, write: false, metafile: true, format: 'esm', logLevel: 'silent' });
  const outputs = Object.values(result.metafile.outputs);
  check(outputs.length === 1 && !result.warnings.some(value => ['unsupported-dynamic-import', 'unsupported-require-call'].includes(value.id)), 'ARTIFACT_MODULE_PARSE_FAILED');
  return outputs[0].imports.map(value => value.path);
}
export function validateModuleImports(modules, mainModule, imports) {
  const names = new Set(modules.map(value => value.name));
  const needed = new Set();
  for (const specifier of imports) {
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const target = posix.normalize(posix.join(posix.dirname(mainModule), specifier));
      check(!specifier.includes('\\') && !target.startsWith('../') && target !== '..', 'ARTIFACT_MODULE_IMPORT_INVALID');
      check(names.has(target), 'ARTIFACT_MODULE_MISSING'); needed.add(target);
    } else check(builtins.has(specifier) || specifier === 'cloudflare:workers' || specifier === 'cloudflare:sockets', 'ARTIFACT_EXTERNAL_IMPORT_UNSUPPORTED');
  }
  for (const module of modules) if (module.name !== mainModule) check(needed.has(module.name), 'ARTIFACT_MODULE_UNREFERENCED');
}

export function uploadConfigFor(original, { directory, mainModule, modules, assetsDirectory }) {
  const result = structuredClone(original);
  result.main = join(directory, mainModule);
  delete result.build;
  result.no_bundle = true;
  const sidecars = modules.filter(value => value.name !== mainModule);
  result.find_additional_modules = sidecars.length > 0;
  result.rules = [...new Set(sidecars.map(value => value.type))].sort().map(type => ({ type, globs: sidecars.filter(value => value.type === type).map(value => value.name), fallthrough: false }));
  if (assetsDirectory) result.assets = { ...result.assets, directory: assetsDirectory };
  return result;
}

/** Called only after this worker's Wrangler dry-run has succeeded. */
export async function exportWorkerArtifact({ artifactDir, key, packageDir, original, esbuild }) {
  check(/^[a-z][a-z0-9-]*$/.test(key), 'ARTIFACT_WORKER_INVALID');
  const directory = join(artifactDir, 'workers', key), outDir = join(directory, 'modules');
  const modules = [];
  for (const name of await walk(outDir)) {
    if (name.endsWith('.map') || name === 'README.md') continue;
    const type = TYPES[extname(name)]; check(type, 'ARTIFACT_MODULE_TYPE_UNSUPPORTED');
    const record = await fileRecord(outDir, name);
    modules.push({ name: name.split(sep).join('/'), type, sha256: record.sha256, size: record.size });
  }
  const esm = modules.filter(value => value.type === 'ESModule');
  check(esm.length === 1, 'ARTIFACT_ESM_COUNT_INVALID');
  validateModuleImports(modules, esm[0].name, await inspectModuleImports(esbuild, await readFile(join(outDir, esm[0].name))));
  let assetsDirectory;
  if (original.assets?.directory) {
    assetsDirectory = join(directory, 'assets');
    const source = resolve(packageDir, original.assets.directory);
    check(await realpath(source) === source && (await lstat(source)).isDirectory(), 'ARTIFACT_ASSET_DIRECTORY_INVALID');
    await mkdir(assetsDirectory, { mode: 0o700 });
    for (const name of await walk(source)) {
      await regularFile(join(source, name));
      await mkdir(dirname(join(assetsDirectory, name)), { recursive: true, mode: 0o700 });
      await copyFile(join(source, name), join(assetsDirectory, name));
    }
  }
  const upload = uploadConfigFor(original, { directory: outDir, mainModule: esm[0].name, modules, assetsDirectory });
  await privateJson(join(directory, 'original.json'), original);
  await privateJson(join(directory, 'upload.json'), upload);
  return { key, name: original.name, mainModule: esm[0].name, modules, original: `workers/${key}/original.json`, config: `workers/${key}/upload.json`, assets: assetsDirectory ? `workers/${key}/assets` : null };
}

/** Capture immutable identity; the uploader revalidates these exact files before writing. */
export async function captureBuildInputs({ sourceRoot, configFile, pluginInventory, overlayFile }) {
  sourceRoot = resolve(sourceRoot);
  check(await realpath(sourceRoot) === sourceRoot, 'ARTIFACT_SOURCE_INVALID');
  const git = args => spawnSync('git', ['-C', sourceRoot, ...args], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  const head = git(['rev-parse', 'HEAD']), top = git(['rev-parse', '--show-toplevel']), status = git(['status', '--porcelain', '--untracked-files=all']);
  check(head.status === 0 && /^[a-f0-9]{40}$/.test(head.stdout.trim()) && top.status === 0 && top.stdout.trim() === sourceRoot && status.status === 0 && status.stdout === '', 'ARTIFACT_SOURCE_NOT_CLEAN');
  const record = async file => {
    file = resolve(file); await regularFile(file);
    return { path: file, sha256: digest(await readFile(file)) };
  };
  return { sourceRoot, sourceRevision: head.stdout.trim(), deployment: await record(configFile), pluginInventory: pluginInventory ? await record(pluginInventory) : null, overlay: overlayFile ? await record(overlayFile) : null };
}
export async function verifyBuildInputs(inputs) {
  const actual = await captureBuildInputs({ sourceRoot: inputs.sourceRoot, configFile: inputs.deployment.path, pluginInventory: inputs.pluginInventory?.path, overlayFile: inputs.overlay?.path });
  equal(actual, inputs);
}

/** Publish the manifest last: its existence means all requested checks and dry-runs passed. */
export async function finalizeArtifactManifest({ artifactDir, inputs, prepared, workers }) {
  await verifyBuildInputs(inputs);
  check(workers.length > 0 && new Set(workers.map(value => value.key)).size === workers.length, 'ARTIFACT_WORKERS_INVALID');
  const files = [];
  let total = 0;
  for (const name of await walk(artifactDir)) {
    const record = await fileRecord(artifactDir, name.split(sep).join('/'));
    total += record.size; check(total <= MAX_BYTES, 'ARTIFACT_SIZE_LIMIT'); files.push(record);
  }
  const manifest = { apiVersion: 1, inputs, prepared, workers, files };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await privateJson(join(artifactDir, 'manifest.json'), manifest);
  for (const name of await walk(artifactDir)) await chmod(join(artifactDir, name), 0o400);
  // File modes are a guard against accidental mutation, not an isolation boundary.
  const seal = async directory => { for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await seal(join(directory, entry.name)); await chmod(directory, 0o500); };
  await seal(artifactDir);
  return { manifestDigest: digest(bytes), workers: workers.length };
}

export async function verifyArtifactManifest({ artifactDir, manifestDigest }) {
  artifactDir = resolve(artifactDir);
  const info = await lstat(artifactDir);
  check(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o077) === 0 && await realpath(artifactDir) === artifactDir, 'ARTIFACT_DIRECTORY_INVALID');
  check(isDigest(manifestDigest), 'ARTIFACT_MANIFEST_DIGEST_REQUIRED');
  const file = join(artifactDir, 'manifest.json'); await regularFile(file);
  const bytes = await readFile(file); check(digest(bytes) === manifestDigest, 'ARTIFACT_MANIFEST_CHANGED');
  const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  check(manifest.apiVersion === 1 && Array.isArray(manifest.workers) && manifest.workers.length > 0 && Array.isArray(manifest.files), 'ARTIFACT_MANIFEST_INVALID');
  await verifyBuildInputs(manifest.inputs);
  const expectedNames = manifest.files.map(value => localName(value.file));
  check(new Set(expectedNames).size === expectedNames.length, 'ARTIFACT_MANIFEST_INVALID');
  equal((await walk(artifactDir)).filter(value => value !== 'manifest.json').sort(), [...expectedNames].sort());
  for (const expected of manifest.files) equal(await fileRecord(artifactDir, expected.file), expected);
  for (const worker of manifest.workers) {
    check(/^[a-z][a-z0-9-]*$/.test(worker.key) && worker.original === `workers/${worker.key}/original.json` && worker.config === `workers/${worker.key}/upload.json`, 'ARTIFACT_WORKER_INVALID');
    const original = JSON.parse(await readFile(join(artifactDir, worker.original), 'utf8'));
    const upload = JSON.parse(await readFile(join(artifactDir, worker.config), 'utf8'));
    const directory = join(artifactDir, 'workers', worker.key, 'modules');
    const assetsDirectory = worker.assets ? join(artifactDir, `workers/${worker.key}/assets`) : undefined;
    check(worker.assets === null || worker.assets === `workers/${worker.key}/assets`, 'ARTIFACT_ASSET_DIRECTORY_INVALID');
    check(worker.name === original.name && worker.modules.filter(value => value.type === 'ESModule').length === 1 && worker.modules.some(value => value.name === worker.mainModule && value.type === 'ESModule'), 'ARTIFACT_WORKER_INVALID');
    for (const module of worker.modules) {
      localName(module.name); check(TYPES[extname(module.name)] === module.type, 'ARTIFACT_MODULE_TYPE_UNSUPPORTED');
      const actual = await fileRecord(directory, module.name);
      check(actual.sha256 === module.sha256 && actual.size === module.size, 'ARTIFACT_MODULE_CHANGED');
    }
    equal(uploadConfigFor(original, { directory, mainModule: worker.mainModule, modules: worker.modules, assetsDirectory }), upload);
  }
  check(new Set(manifest.workers.map(value => value.key)).size === manifest.workers.length, 'ARTIFACT_WORKERS_INVALID');
  return manifest;
}

/** Durable, exclusive write intent: an uncertain attempt can never be replayed automatically. */
export async function markUploadAttempt(file, value) {
  file = resolve(file);
  check(await realpath(dirname(file)) === dirname(file), 'ARTIFACT_ATTEMPT_PARENT_INVALID');
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); } finally { await handle.close(); }
  const parent = await open(dirname(file), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
