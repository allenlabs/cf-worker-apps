import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { applyHostInventory, parseHostManifest } from '../scripts/apply-host-plugin-inventory.mjs';
import { PREFIX, buildBundleArtifact, buildNpmArtifact, canonicalSource, hash, installationId, parseArtifact, parseDesired, parseRequest } from '../scripts/plugin-artifacts.mjs';
import { parseRunnerConfig, runInstaller } from '../scripts/plugin-installer.mjs';

const wrapper = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const esbuildModule = process.env.PLUGIN_TEST_ESBUILD;
const typescriptModule = process.env.PLUGIN_TEST_TYPESCRIPT;
const requiresBuilder = { skip: (!esbuildModule || !typescriptModule) && 'Set PLUGIN_TEST_ESBUILD and PLUGIN_TEST_TYPESCRIPT to installed compiler modules to run the build checks.' };
const moduleText = 'globalThis.__syntheticPluginWasEvaluated = true; export default {id:"synthetic",setup(ctx){ctx.tool.transform(t=>t.add({name:"echo",description:"Echo",parameters:{type:"object"},execute:async x=>x}));}};';
const packageIntegrity = 'sha512-' + createHash('sha512').update('synthetic').digest('base64');
function resource(execution = 'dynamic', source = { kind: 'bundle', digest: hash(moduleText) }, id = 'plugin-one') {
  return { id, name: 'Synthetic plugin', scope: { kind: 'organization' }, enabled: true, kind: 'plugin', pluginId: 'package', source, execution, options: '{}' };
}
async function temporary(t) { const dir = await mkdtemp(join(tmpdir(), 'plugin-installer-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
async function json(file, value) { await mkdir(dirname(file), { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify(value), { mode: 0o600 }); }
async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
function git(root, args) {
  const out = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: root, LANG: 'C.UTF-8', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  assert.equal(out.status, 0, out.stderr); return out.stdout.trim();
}

async function fixture(t, selected, mode = 'normal') {
  const directory = await temporary(t), remote = join(directory, 'objects'), sourceRoot = join(directory, 'source');
  const stateDir = join(directory, 'private-state'), deploymentConfig = join(directory, 'deployment.json');
  await mkdir(remote); await mkdir(sourceRoot); await json(deploymentConfig, { name: 'synthetic-deployment' });
  git(sourceRoot, ['init', '--quiet']); await writeFile(join(sourceRoot, 'source.js'), '// synthetic source\n');
  git(sourceRoot, ['add', 'source.js']); git(sourceRoot, ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '--quiet', '-m', 'Synthetic source']);
  const transport = join(directory, 'transport.mjs');
  await writeFile(transport, `import {mkdir,readFile,writeFile} from 'node:fs/promises'; import {dirname,join} from 'node:path';
const [root,mode] = process.argv.slice(2); let raw=''; for await (const part of process.stdin) raw+=part;
const request=JSON.parse(raw); const file=join(root,request.key);
if(mode==='hold' && request.operation==='get' && request.key==='${PREFIX}desired.json') {await writeFile(join(root,'hold-ready'),'ready'); await new Promise(resolve=>setTimeout(resolve,30000));}
if(request.operation==='get') {
 let bytes; try {bytes=await readFile(file);} catch(e) {if(e.code!=='ENOENT') throw e; process.stdout.write(JSON.stringify({ok:true,found:false})); process.exit(0);}
 await mkdir(dirname(request.file),{recursive:true}); await writeFile(request.file,bytes,{mode:0o600});
 process.stdout.write(JSON.stringify({ok:true,found:true,file:mode==='wrong-file'?request.file+'.wrong':request.file}));
} else {
 if(mode==='artifact-cut' && request.key.includes('/artifacts/')) {
   try {await readFile(join(root,'cut-once'));} catch(e) {if(e.code!=='ENOENT') throw e; await writeFile(join(root,'cut-once'),'cut'); process.exit(2);}
 }
 await mkdir(dirname(file),{recursive:true}); await writeFile(file,await readFile(request.file),{mode:0o600});
 if(mode==='stale' && request.key.includes('/artifacts/')) {const desired=join(root,'${PREFIX}desired.json'); const value=JSON.parse(await readFile(desired)); value.revision++; await writeFile(desired,JSON.stringify(value));}
 process.stdout.write(JSON.stringify({ok:true,found:true}));
}
`);
  const deploy = join(directory, 'deploy.mjs'), deployReceipt = join(directory, 'deploy-receipt.json');
  await writeFile(deploy, `import {readFile,writeFile} from 'node:fs/promises'; import {createHash} from 'node:crypto';
const [receipt,mode,manifest] = process.argv.slice(2); const bytes=await readFile(manifest); const manifestDigest=createHash('sha256').update(bytes).digest('hex');
await writeFile(receipt,JSON.stringify({manifest,manifestDigest})); process.stdout.write(JSON.stringify({ok:true,accepted:true,manifestDigest:mode==='wrong-deploy'?'0'.repeat(64):manifestDigest}));
`);
  const npmCommand = join(directory, 'npm');
  await writeFile(npmCommand, `#!${process.execPath}
const fs=require('node:fs'); const path=require('node:path');
if(process.argv.includes('--help')) {process.stdout.write('--allow-directory --allow-file --allow-git --allow-remote'); process.exit(0);}
if(!process.argv.includes('--ignore-scripts') || !process.argv.includes('--save-exact') || process.env.SYNTHETIC_SECRET || process.env.NODE_OPTIONS || !process.env.HOME.includes('home')) process.exit(42);
if(!['--allow-directory=none','--allow-file=none','--allow-git=none','--allow-remote=none','--no-bin-links'].every(flag=>process.argv.includes(flag))) process.exit(43);
const spec=process.argv.at(-1), split=spec.lastIndexOf('@'), name=spec.slice(0,split), version=spec.slice(split+1);
const target=path.join(process.cwd(),'node_modules',name); fs.mkdirSync(target,{recursive:true});
fs.writeFileSync(path.join(target,'package.json'),JSON.stringify({name,version,type:'module',exports:'./index.js',scripts:{postinstall:'exit 42'}}));
fs.writeFileSync(path.join(target,'index.js'),${JSON.stringify(moduleText)});
fs.writeFileSync(path.join(process.cwd(),'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{['node_modules/'+name]:{version,integrity:${JSON.stringify(packageIntegrity)}}}}));
`); await chmod(npmCommand, 0o700);
  const config = { apiVersion: 1, transportCommand: [process.execPath, transport, remote, mode], deployCommand: [process.execPath, deploy, deployReceipt, mode], stateDir, esbuildModule: esbuildModule ?? '/synthetic/esbuild/lib/main.js', typescriptModule: typescriptModule ?? '/synthetic/typescript/lib/typescript.js', npmCommand, sourceRoot, deploymentConfig };
  const desired = { apiVersion: 1, revision: 1, plugins: selected };
  await json(join(remote, `${PREFIX}desired.json`), desired);
  for (const plugin of selected) {
    const id = installationId(plugin);
    await json(join(remote, `${PREFIX}requests/${id}.json`), { apiVersion: 1, id, resourceId: plugin.id, source: plugin.source, execution: plugin.execution });
    if (plugin.source.kind === 'bundle') {
      await mkdir(join(remote, `${PREFIX}bundles`), { recursive: true });
      await writeFile(join(remote, `${PREFIX}bundles`, `${plugin.source.digest}.mjs`), moduleText, { mode: 0o600 });
    }
  }
  return { directory, remote, config, desired, deployReceipt };
}

test('canonical IDs ignore npm object property order and options, but bind source and execution', () => {
  const left = resource('host', { kind: 'npm', name: '@synthetic/plugin', version: '1.2.3' });
  const right = { ...left, options: '{"changed":true}', source: { version: '1.2.3', name: '@synthetic/plugin', kind: 'npm' } };
  assert.equal(installationId(left), installationId(right));
  assert.notEqual(installationId(left), installationId({ ...left, execution: 'dynamic' }));
  assert.notEqual(installationId(left), installationId({ ...left, source: { ...left.source, version: '1.2.4' } }));
  assert.throws(() => canonicalSource({ kind: 'npm', name: 'plugin', version: 'latest' }));
  assert.throws(() => canonicalSource({ kind: 'npm', name: 'plugin', version: '1.2.3-01' }));
  assert.throws(() => canonicalSource({ kind: 'npm', name: '../plugin', version: '1.2.3' }));
});
test('schemas reject mismatched requests, approval bypasses, and false provenance', () => {
  const plugin = resource(); const id = installationId(plugin);
  assert.equal(parseRequest({ apiVersion: 1, id, resourceId: plugin.id, source: plugin.source, execution: 'dynamic' }).id, id);
  assert.throws(() => parseRequest({ apiVersion: 1, id, resourceId: 'different', source: plugin.source, execution: 'dynamic' }));
  assert.throws(() => parseDesired({ apiVersion: 1, revision: 1, plugins: [{ ...plugin, execution: 'pending' }] }));
  assert.throws(() => parseDesired({ apiVersion: 1, revision: 1, plugins: [plugin, plugin] }));
  for (const options of ['[]', 'null', '{"n":1e999}', 'invalid']) assert.throws(() => parseDesired({ apiVersion: 1, revision: 1, plugins: [{ ...plugin, options }] }));
  assert.throws(() => parseArtifact({ apiVersion: 1, source: { kind: 'npm', name: 'plugin', version: '1.2.3' }, module: moduleText, packageIntegrity: null, lockDigest: null }));
  assert.throws(() => parseRunnerConfig({}));
});
test('compiler builds an authored npm package without evaluating it or inheriting secrets', requiresBuilder, async t => {
  const context = await fixture(t, []);
  await mkdir(context.config.stateDir, { mode: 0o700 });
  process.env.SYNTHETIC_SECRET = 'synthetic-value';
  try {
    const artifact = await buildNpmArtifact({ source: { kind: 'npm', name: '@synthetic/plugin', version: '1.2.3' }, ...context.config });
    assert.equal(artifact.packageIntegrity, packageIntegrity); assert.match(artifact.lockDigest, /^[a-f0-9]{64}$/);
    assert.match(artifact.module, /syntheticPluginWasEvaluated/); assert.equal(globalThis.__syntheticPluginWasEvaluated, undefined);
  } finally { delete process.env.SYNTHETIC_SECRET; }
});
test('npm dependency policies must be advertised before installation', async t => {
  const context = await fixture(t, []);
  await mkdir(context.config.stateDir, { mode: 0o700 });
  const marker = join(context.directory, 'unexpected-install');
  await writeFile(context.config.npmCommand, `#!${process.execPath}\nconst fs=require('node:fs'); if(process.argv.includes('--help')) {process.stdout.write('--ignore-scripts'); process.exit(0);} fs.writeFileSync(${JSON.stringify(marker)},'unexpected');\n`);
  await assert.rejects(buildNpmArtifact({ source: { kind: 'npm', name: 'synthetic-plugin', version: '1.0.0' }, ...context.config }), /PLUGIN_NPM_CAPABILITY_UNSUPPORTED/);
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});
test('portable compiler rejects forged bundle bytes, external imports, and missing native exports', requiresBuilder, async t => {
  const directory = await temporary(t);
  await assert.rejects(buildBundleArtifact({ source: resource().source, bytes: Buffer.from('different'), stateDir: directory, esbuildModule, typescriptModule }), /PLUGIN_BUNDLE_DIGEST_MISMATCH/);
  for (const contents of ['import fs from "node:fs"; export default fs;', 'export const wrong = {};', 'export default import("https://example.invalid/plugin.js");']) {
    await assert.rejects(buildBundleArtifact({ source: { kind: 'bundle', digest: hash(contents) }, bytes: Buffer.from(contents), stateDir: directory, esbuildModule, typescriptModule }));
  }
  const outside = join(directory, 'outside.js'); await writeFile(outside, 'export default "synthetic-sensitive-value";');
  const contents = `import value from ${JSON.stringify(outside)}; export default value;`;
  await assert.rejects(buildBundleArtifact({ source: { kind: 'bundle', digest: hash(contents) }, bytes: Buffer.from(contents), stateDir: directory, esbuildModule, typescriptModule }), /PLUGIN_IMPORT_OUTSIDE_BUILD/);
});
test('portable compiler rejects computed imports, require aliases, and code generation', requiresBuilder, async t => {
  const directory = await temporary(t);
  for (const body of [
    'const target=ctx.options.module; await import(target);',
    'const target=ctx.options.module; require(target);',
    'const load=require; load(ctx.options.module);',
    'require.resolve(ctx.options.module);',
    'eval(ctx.options.code);',
    'const run=eval; run(ctx.options.code);',
    'new Function(ctx.options.code)();',
    'globalThis["Function"](ctx.options.code)();',
    'globalThis["require"](ctx.options.module);',
  ]) {
    const contents = `export default {id:'synthetic',async setup(ctx){${body}}};`;
    await assert.rejects(buildBundleArtifact({ source: { kind: 'bundle', digest: hash(contents) }, bytes: Buffer.from(contents), stateDir: directory, esbuildModule, typescriptModule }), /PLUGIN_DYNAMIC_IMPORT_UNSUPPORTED/);
  }
  const contents = `export default {id:'synthetic',setup(ctx){const description='import(x), require(x), eval(x), Function(x)'; ctx.tool.transform(tools=>tools.add({name:'echo',description,input:{type:'object'},execute:async()=>({content:description})}));}};`;
  const artifact = await buildBundleArtifact({ source: { kind: 'bundle', digest: hash(contents) }, bytes: Buffer.from(contents), stateDir: directory, esbuildModule, typescriptModule });
  assert.match(artifact.module, /import\(x\), require\(x\), eval\(x\), Function\(x\)/);
});
test('concurrent runners are excluded and SIGKILL releases the kernel lock', async t => {
  const context = await fixture(t, [], 'hold'), configFile = join(context.directory, 'runner.json');
  await json(configFile, context.config);
  const child = spawn(process.execPath, [join(wrapper, 'scripts/plugin-installer.mjs'), '--config', configFile, '--once'], { detached: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } });
  let ready = false;
  for (let checks = 0; checks < 100; checks++) {
    try { await readFile(join(context.remote, 'hold-ready')); ready = true; break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(ready, true);
  assert.equal((await runInstaller(context.config)).busy, true);
  process.kill(-child.pid, 'SIGKILL'); await exited;
  const recovered = await runInstaller({ ...context.config, transportCommand: context.config.transportCommand.slice(0, -1).concat('normal') });
  assert.equal(recovered.busy, false); assert.equal(recovered.inspected, 0);
});
test('--once uploads an immutable artifact before ready and reuses the exact result', requiresBuilder, async t => {
  const plugin = resource(), context = await fixture(t, [plugin]);
  const result = await runInstaller(context.config);
  assert.deepEqual({ built: result.built, ready: result.ready, deployed: result.deployed }, { built: 1, ready: 1, deployed: false });
  const installed = await readJson(join(context.remote, `${PREFIX}results/${installationId(plugin)}.json`));
  assert.equal(installed.status, 'ready');
  const bytes = await readFile(join(context.remote, `${PREFIX}artifacts/${installed.artifactDigest}.json`));
  assert.equal(hash(bytes), installed.artifactDigest); assert.equal(JSON.parse(bytes).source.digest, plugin.source.digest);
  const repeated = await runInstaller(context.config); assert.equal(repeated.built, 0); assert.equal(repeated.ready, 1);
  assert.equal(globalThis.__syntheticPluginWasEvaluated, undefined);
});

test('an interrupted artifact publication resumes without a dangling digest checkpoint', requiresBuilder, async t => {
  const plugin = resource(), context = await fixture(t, [plugin], 'artifact-cut');
  await assert.rejects(runInstaller(context.config), /PLUGIN_COMMAND_FAILED/);
  const interrupted = await readJson(join(context.remote, `${PREFIX}results/${installationId(plugin)}.json`));
  assert.equal(interrupted.status, 'verifying');
  assert.equal(interrupted.artifactDigest, null);
  assert.equal((await runInstaller(context.config)).ready, 1);
});
test('host deploy receives an exact manifest and an unchanged second poll does not deploy', requiresBuilder, async t => {
  const plugin = resource('host'), context = await fixture(t, [plugin]);
  const first = await runInstaller(context.config); assert.equal(first.deployed, true); assert.equal(first.ready, 1);
  const receipt = await readJson(context.deployReceipt), manifest = parseHostManifest(await readJson(receipt.manifest));
  assert.equal(hash(await readFile(receipt.manifest)), receipt.manifestDigest); assert.equal(manifest.desired.digest, hash(JSON.stringify(context.desired)));
  assert.equal(manifest.deployment.configDigest, hash(await readFile(context.config.deploymentConfig)));
  const second = await runInstaller(context.config); assert.equal(second.deployed, false); assert.equal(second.built, 0);
});
test('desired snapshot changes block deployment and a mismatched get destination fails closed', requiresBuilder, async t => {
  const stale = await fixture(t, [resource('host')], 'stale');
  await assert.rejects(runInstaller(stale.config), /PLUGIN_DESIRED_SNAPSHOT_CHANGED/);
  await assert.rejects(readFile(stale.deployReceipt), { code: 'ENOENT' });
  const wrong = await fixture(t, [], 'wrong-file');
  await assert.rejects(runInstaller(wrong.config), /PLUGIN_TRANSPORT_FILE_MISMATCH/);
});
test('dirty source blocks a host deployment', requiresBuilder, async t => {
  const context = await fixture(t, [resource('host')]);
  await writeFile(join(context.config.sourceRoot, 'untracked.js'), '// untracked\n');
  await assert.rejects(runInstaller(context.config), /PLUGIN_DEPLOY_SOURCE_NOT_CLEAN/);
  await assert.rejects(readFile(context.deployReceipt), { code: 'ENOENT' });
});
test('an ambiguous host deploy is recorded failed and never silently retried', requiresBuilder, async t => {
  const plugin = resource('host'), context = await fixture(t, [plugin], 'wrong-deploy');
  const first = await runInstaller(context.config); assert.equal(first.deployed, false); assert.equal(first.failed, 1);
  const record = await readJson(join(context.remote, `${PREFIX}results/${installationId(plugin)}.json`));
  assert.equal(record.status, 'failed'); assert.equal(record.error, 'PLUGIN_HOST_DEPLOYMENT_UNVERIFIED');
  const firstReceipt = await readFile(context.deployReceipt);
  const second = await runInstaller(context.config); assert.equal(second.built, 0); assert.equal(second.failed, 1);
  assert.equal((await readFile(context.deployReceipt)).equals(firstReceipt), true);
  assert.equal((await readdir(context.config.stateDir)).filter(value => value.endsWith('.attempt.json')).length, 1);
});
test('host registry generation is lazy, source-bound, and only touches a prepared checkout', requiresBuilder, async t => {
  const context = await fixture(t, [resource('host')]); await runInstaller(context.config);
  const receipt = await readJson(context.deployReceipt);
  const checkout = join(context.directory, 'prepared/cloudflare-os'), src = join(checkout, 'packages/workshop-backend/src');
  await mkdir(src, { recursive: true }); await json(join(dirname(checkout), 'prepared.json'), { upstream: 'a'.repeat(40), overlayHash: 'b'.repeat(64) });
  await writeFile(join(src, 'installed-agent-plugins.ts'), '// Cloud Agent OS installed plugin registry placeholder.\nexport const installedAgentPlugins = {};\n');
  const result = await applyHostInventory({ manifestFile: receipt.manifest, checkout }); assert.equal(result.artifacts, 1);
  const registry = await readFile(join(src, 'installed-agent-plugins.ts'), 'utf8'); assert.match(registry, /\(\) => import\(/); assert.doesNotMatch(registry, /^import \*/m);
  const typecheck = spawnSync(process.execPath, [join(dirname(typescriptModule), 'tsc.js'), '--strict', '--noEmit', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', join(src, 'installed-agent-plugins.ts')], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(typecheck.status, 0, typecheck.stdout + typecheck.stderr);
  const manifest = await readJson(receipt.manifest), module = join(src, 'installed-agent-plugin-modules', `${manifest.artifacts[0].digest}.mjs`);
  assert.match(await readFile(module, 'utf8'), /syntheticPluginWasEvaluated/); assert.equal(globalThis.__syntheticPluginWasEvaluated, undefined);
  assert.equal((await applyHostInventory({ manifestFile: receipt.manifest, checkout })).artifacts, 1);
  await assert.rejects(applyHostInventory({ manifestFile: receipt.manifest, checkout: context.config.sourceRoot }));
  await chmod(manifest.artifacts[0].file, 0o600); await writeFile(manifest.artifacts[0].file, 'tampered');
  await assert.rejects(applyHostInventory({ manifestFile: receipt.manifest, checkout }), /PLUGIN_ARTIFACT_DIGEST_MISMATCH/);
});
test('the per-poll build budget defers excess jobs and host removal deploys an empty inventory', requiresBuilder, async t => {
  const first = resource('dynamic', undefined, 'plugin-first'), second = resource('dynamic', undefined, 'plugin-second');
  const dynamic = await fixture(t, [first, second]);
  const one = await runInstaller({ ...dynamic.config, maxJobs: 1 }); assert.equal(one.built, 1); assert.equal(one.deferred, 1);
  const two = await runInstaller({ ...dynamic.config, maxJobs: 1 }); assert.equal(two.built, 1); assert.equal(two.ready, 2);
  const host = await fixture(t, [resource('host')]); await runInstaller(host.config);
  await json(join(host.remote, `${PREFIX}desired.json`), { apiVersion: 1, revision: 2, plugins: [] });
  const removed = await runInstaller(host.config); assert.equal(removed.deployed, true);
  const receipt = await readJson(host.deployReceipt), manifest = await readJson(receipt.manifest);
  assert.deepEqual(manifest.installations, []); assert.deepEqual(manifest.artifacts, []);
});
test('the CLI emits only a bounded JSON receipt and no private content', requiresBuilder, async t => {
  const context = await fixture(t, [resource()]), configFile = join(context.directory, 'runner.json');
  await json(configFile, context.config);
  const result = spawnSync(process.execPath, [join(wrapper, 'scripts/plugin-installer.mjs'), '--config', configFile, '--once'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr); const parsed = JSON.parse(result.stdout); assert.equal(parsed.ready, 1);
  assert.equal(result.stdout.includes(context.directory), false); assert.equal(result.stdout.includes('Synthetic plugin'), false);
});
