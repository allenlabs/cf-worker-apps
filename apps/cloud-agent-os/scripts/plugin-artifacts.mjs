import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREFIX = 'agent-plugins/v1/';
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_DESIRED_BYTES = 120_000;
const digestPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function check(value, code = 'INVALID_PLUGIN_RECORD') { assert(value, code); }
function record(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value));
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)));
  return value;
}
function text(value, max) { check(typeof value === 'string' && value.length > 0 && value.length <= max); return value; }
export function validDigest(value) { check(typeof value === 'string' && digestPattern.test(value)); return value; }
export function canonicalSource(value) {
  if (value?.kind === 'npm') {
    record(value, ['kind', 'name', 'version']);
    check(typeof value.name === 'string' && value.name.length <= 214 && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value.name));
    check(typeof value.version === 'string' && value.version.length <= 128 && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value.version));
    const prerelease = value.version.split('+')[0].split('-').slice(1).join('-');
    check(!prerelease.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part.startsWith('0')));
    return { kind: 'npm', name: value.name, version: value.version };
  }
  record(value, ['kind', 'digest']);
  check(value.kind === 'bundle');
  return { kind: 'bundle', digest: validDigest(value.digest) };
}
export function installationId(resource) {
  return hash(JSON.stringify({ resourceId: resource.id, source: canonicalSource(resource.source), execution: resource.execution }));
}
export function parseRequest(input) {
  record(input, ['apiVersion', 'id', 'resourceId', 'source', 'execution']);
  check(input.apiVersion === 1 && typeof input.resourceId === 'string' && idPattern.test(input.resourceId) && ['host', 'dynamic'].includes(input.execution));
  const result = { apiVersion: 1, id: validDigest(input.id), resourceId: input.resourceId, source: canonicalSource(input.source), execution: input.execution };
  check(installationId({ id: result.resourceId, source: result.source, execution: result.execution }) === result.id, 'PLUGIN_REQUEST_ID_MISMATCH');
  return result;
}
function scope(value) {
  if (value?.kind === 'organization') record(value, ['kind']);
  else if (value?.kind === 'team') { record(value, ['kind', 'teamId']); check(typeof value.teamId === 'string' && idPattern.test(value.teamId)); }
  else { record(value, ['kind', 'userId']); check(value.kind === 'personal'); text(value.userId, 320); check(!/[\s\x00-\x1f\x7f-\x9f]/u.test(value.userId)); }
}
export function parseDesired(input) {
  record(input, ['apiVersion', 'revision', 'plugins']);
  check(input.apiVersion === 1 && Number.isSafeInteger(input.revision) && input.revision >= 0 && Array.isArray(input.plugins) && input.plugins.length <= 500);
  const ids = new Set();
  for (const value of input.plugins) {
    record(value, ['id', 'name', 'scope', 'enabled', 'kind', 'pluginId', 'source', 'execution', 'options']);
    check(typeof value.id === 'string' && idPattern.test(value.id) && !ids.has(value.id)); ids.add(value.id);
    text(value.name, 120); scope(value.scope);
    check(value.kind === 'plugin' && value.pluginId === 'package' && typeof value.enabled === 'boolean' && ['host', 'dynamic'].includes(value.execution));
    canonicalSource(value.source);
    check(typeof value.options === 'string' && Buffer.byteLength(value.options) <= 16_384);
    const options = JSON.parse(value.options);
    check(options && typeof options === 'object' && !Array.isArray(options));
    const pending = [{ value: options, depth: 0 }]; let nodes = 0;
    while (pending.length > 0) {
      const current = pending.pop();
      check(++nodes <= 2048 && current.depth <= 16 && (typeof current.value !== 'number' || Number.isFinite(current.value)));
      if (current.value && typeof current.value === 'object') for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 });
    }
  }
  return input;
}
export function parseArtifact(input, source) {
  record(input, ['apiVersion', 'source', 'module', 'packageIntegrity', 'lockDigest']);
  check(input.apiVersion === 1 && typeof input.module === 'string' && input.module.length > 0 && Buffer.byteLength(input.module) <= MAX_ARTIFACT_BYTES);
  const parsedSource = canonicalSource(input.source);
  check(!source || JSON.stringify(parsedSource) === JSON.stringify(canonicalSource(source)), 'PLUGIN_ARTIFACT_SOURCE_MISMATCH');
  if (input.packageIntegrity !== null) {
    check(typeof input.packageIntegrity === 'string' && input.packageIntegrity.length <= 1024);
    const integrity = /^sha(256|384|512)-([A-Za-z0-9+/]+={0,2})$/.exec(input.packageIntegrity);
    check(integrity !== null);
    const bytes = Buffer.from(integrity[2], 'base64');
    check(bytes.length === Number(integrity[1]) / 8 && bytes.toString('base64') === integrity[2]);
  }
  check(input.lockDigest === null || digestPattern.test(input.lockDigest));
  check(parsedSource.kind !== 'npm' || input.packageIntegrity !== null && input.lockDigest !== null);
  check(parsedSource.kind !== 'bundle' || input.packageIntegrity === null && input.lockDigest === null);
  return input;
}
export async function readBounded(file, max) {
  const info = await lstat(file);
  check(info.isFile() && !info.isSymbolicLink() && info.size <= max, 'PLUGIN_FILE_INVALID');
  const bytes = await readFile(file);
  check(bytes.length <= max, 'PLUGIN_FILE_TOO_LARGE');
  return bytes;
}
export function parseJson(bytes) {
  const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return JSON.parse(value);
}
export async function immutableFile(file, bytes) {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  try { await writeFile(file, bytes, { flag: 'wx', mode: 0o400 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; check((await readBounded(file, MAX_ARTIFACT_BYTES)).equals(Buffer.from(bytes)), 'PLUGIN_IMMUTABLE_FILE_MISMATCH'); }
}
export function minimalEnv(home) {
  return { PATH: process.env.PATH ?? '', HOME: home, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TMPDIR: join(home, 'tmp') };
}
export async function compilePortableModule({ esbuildModule, typescriptModule, project, entryPoint, contents }) {
  check(isAbsolute(esbuildModule), 'PLUGIN_ESBUILD_PATH_REQUIRED');
  check(isAbsolute(typescriptModule), 'PLUGIN_TYPESCRIPT_PATH_REQUIRED');
  const { build } = await import(pathToFileURL(esbuildModule).href);
  const base = await realpath(project);
  let files = 0, inputBytes = 0;
  const result = await build({
    ...(entryPoint ? { entryPoints: [entryPoint] } : { stdin: { contents, sourcefile: 'plugin-input.js', resolveDir: project } }),
    absWorkingDir: project, bundle: true, write: false, outfile: 'plugin.js', metafile: true,
    platform: 'browser', format: 'esm', target: 'es2022', conditions: ['workerd', 'worker', 'browser'],
    logLevel: 'silent', legalComments: 'none', sourcemap: false, tsconfigRaw: {},
    plugins: [{ name: 'portable-plugin-files', setup(context) {
      context.onResolve({ filter: /^(?:https?:|data:|file:|node:|cloudflare:)/ }, () => ({ errors: [{ text: 'PLUGIN_EXTERNAL_IMPORT_UNSUPPORTED' }] }));
      context.onLoad({ filter: /.*/ }, async args => {
        const file = await realpath(args.path);
        const location = relative(base, file);
        check(location !== '..' && !location.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(location), 'PLUGIN_IMPORT_OUTSIDE_BUILD');
        const info = await lstat(file);
        inputBytes += info.size;
        check(info.isFile() && ++files <= 4096 && info.size <= MAX_ARTIFACT_BYTES && inputBytes <= 32 * MAX_ARTIFACT_BYTES, 'PLUGIN_BUILD_INPUT_LIMIT');
        return undefined;
      });
    } }],
  });
  check(result.outputFiles.length === 1 && result.outputFiles[0].contents.length <= MAX_ARTIFACT_BYTES, 'PLUGIN_BUILD_OUTPUT_LIMIT');
  const output = Object.values(result.metafile.outputs);
  check(output.length === 1 && output[0].imports.length === 0, 'PLUGIN_EXTERNAL_IMPORT_UNSUPPORTED');
  check(output[0].exports.includes('default') || output[0].exports.includes('Plugin'), 'PLUGIN_EXPORT_UNSUPPORTED');
  check(!result.warnings.some(value => value.id === 'unsupported-require-call' || value.id === 'unsupported-dynamic-import'), 'PLUGIN_DYNAMIC_IMPORT_UNSUPPORTED');
  const module = result.outputFiles[0].text;
  const imported = await import(pathToFileURL(typescriptModule).href);
  const ts = imported.default ?? imported;
  const syntax = ts.createSourceFile('plugin.js', module, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  check(syntax.parseDiagnostics.length === 0, 'PLUGIN_MODULE_SYNTAX_INVALID');
  const pending = [syntax];
  const unsupportedNames = new Set(['require', 'eval', 'Function']);
  while (pending.length > 0) {
    const node = pending.pop();
    check(!(ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)
      || ts.isExportDeclaration(node) && node.moduleSpecifier
      || ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
      || ts.isIdentifier(node) && unsupportedNames.has(node.text)
      || ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && unsupportedNames.has(node.argumentExpression.text)), 'PLUGIN_DYNAMIC_IMPORT_UNSUPPORTED');
    ts.forEachChild(node, child => { pending.push(child); });
  }
  return module;
}
export async function buildNpmArtifact({ source: input, stateDir, npmCommand, esbuildModule, typescriptModule }) {
  const source = canonicalSource(input); check(source.kind === 'npm');
  const directory = await mkdtemp(join(stateDir, 'build-'));
  const project = join(directory, 'project'), home = join(directory, 'home');
  await mkdir(project, { mode: 0o700 }); await mkdir(join(home, 'tmp'), { recursive: true, mode: 0o700 });
  await writeFile(join(home, 'user.npmrc'), '', { mode: 0o600 });
  await writeFile(join(home, 'global.npmrc'), '', { mode: 0o600 });
  await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'agent-plugin-build', version: '1.0.0', private: true }), { mode: 0o600 });
  const options = {
    cwd: project, encoding: 'utf8', timeout: 180_000, maxBuffer: 1024 * 1024,
    env: { ...minimalEnv(home), npm_config_userconfig: join(home, 'user.npmrc'), npm_config_globalconfig: join(home, 'global.npmrc'), npm_config_cache: join(home, 'cache'), npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' },
  };
  const policyFlags = ['--allow-directory', '--allow-file', '--allow-git', '--allow-remote'];
  const help = spawnSync(npmCommand, ['install', '--help'], { ...options, timeout: 10_000, maxBuffer: 32_768 });
  check(help.status === 0 && !help.error && policyFlags.every(flag => help.stdout.includes(flag)), 'PLUGIN_NPM_CAPABILITY_UNSUPPORTED');
  const outcome = spawnSync(npmCommand, ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-bin-links', '--save-exact', ...policyFlags.map(flag => `${flag}=none`), '--registry=https://registry.npmjs.org', `${source.name}@${source.version}`], options);
  check(outcome.status === 0 && !outcome.error, 'PLUGIN_NPM_INSTALL_FAILED');
  const lockBytes = await readBounded(join(project, 'package-lock.json'), 8 * MAX_ARTIFACT_BYTES);
  const lock = parseJson(lockBytes);
  const entry = lock.packages?.[`node_modules/${source.name}`];
  check(entry?.version === source.version && typeof entry.integrity === 'string', 'PLUGIN_NPM_LOCK_MISMATCH');
  const installed = parseJson(await readBounded(join(project, 'node_modules', source.name, 'package.json'), MAX_ARTIFACT_BYTES));
  check(installed.name === source.name && installed.version === source.version, 'PLUGIN_NPM_PACKAGE_MISMATCH');
  const module = await compilePortableModule({ esbuildModule, typescriptModule, project, entryPoint: source.name });
  const artifact = parseArtifact({ apiVersion: 1, source, module, packageIntegrity: entry.integrity, lockDigest: hash(lockBytes) }, source);
  check(Buffer.byteLength(JSON.stringify(artifact)) <= MAX_ARTIFACT_BYTES, 'PLUGIN_BUILD_OUTPUT_LIMIT');
  return artifact;
}
export async function buildBundleArtifact({ source: input, bytes, stateDir, esbuildModule, typescriptModule }) {
  const source = canonicalSource(input); check(source.kind === 'bundle' && hash(bytes) === source.digest, 'PLUGIN_BUNDLE_DIGEST_MISMATCH');
  const project = await mkdtemp(join(stateDir, 'bundle-'));
  const module = await compilePortableModule({ esbuildModule, typescriptModule, project, contents: new TextDecoder('utf-8', { fatal: true }).decode(bytes) });
  const artifact = parseArtifact({ apiVersion: 1, source, module, packageIntegrity: null, lockDigest: null }, source);
  check(Buffer.byteLength(JSON.stringify(artifact)) <= MAX_ARTIFACT_BYTES, 'PLUGIN_BUILD_OUTPUT_LIMIT');
  return artifact;
}
