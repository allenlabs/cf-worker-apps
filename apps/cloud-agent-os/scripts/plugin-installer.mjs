import { spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  PREFIX, MAX_ARTIFACT_BYTES, MAX_DESIRED_BYTES, buildBundleArtifact, buildNpmArtifact,
  canonicalSource, check, hash, immutableFile, installationId, minimalEnv,
  parseArtifact, parseDesired, parseJson, parseRequest, readBounded, validDigest,
} from './plugin-artifacts.mjs';

function keys(value, required, optional = []) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'PLUGIN_RUNNER_CONFIG_INVALID');
  check(required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => [...required, ...optional].includes(key)), 'PLUGIN_RUNNER_CONFIG_INVALID');
}
export function parseRunnerConfig(value) {
  keys(value, ['apiVersion', 'transportCommand', 'deployCommand', 'stateDir', 'esbuildModule', 'typescriptModule', 'npmCommand', 'sourceRoot', 'deploymentConfig'], ['maxJobs', 'pollSeconds']);
  check(value.apiVersion === 1, 'PLUGIN_RUNNER_CONFIG_INVALID');
  for (const key of ['transportCommand', 'deployCommand']) check(Array.isArray(value[key]) && value[key].length > 0 && value[key].length <= 32 && value[key].every(part => typeof part === 'string' && part.length > 0 && part.length <= 4096 && !part.includes('\0')) && isAbsolute(value[key][0]), 'PLUGIN_RUNNER_COMMAND_INVALID');
  for (const key of ['stateDir', 'esbuildModule', 'typescriptModule', 'npmCommand', 'sourceRoot', 'deploymentConfig']) check(typeof value[key] === 'string' && isAbsolute(value[key]) && !value[key].includes('\0'), 'PLUGIN_RUNNER_PATH_INVALID');
  const stateLocation = relative(value.sourceRoot, value.stateDir);
  check(stateLocation === '..' || stateLocation.startsWith(`..${sep}`) || isAbsolute(stateLocation), 'PLUGIN_RUNNER_STATE_INSIDE_SOURCE');
  check(value.maxJobs === undefined || Number.isSafeInteger(value.maxJobs) && value.maxJobs >= 1 && value.maxJobs <= 100, 'PLUGIN_RUNNER_CONFIG_INVALID');
  check(value.pollSeconds === undefined || Number.isSafeInteger(value.pollSeconds) && value.pollSeconds >= 10 && value.pollSeconds <= 3600, 'PLUGIN_RUNNER_CONFIG_INVALID');
  return { ...value, maxJobs: value.maxJobs ?? 10, pollSeconds: value.pollSeconds ?? 60 };
}
function invoke(command, input, home, timeout = 60_000, finalArg) {
  const result = spawnSync(command[0], [...command.slice(1), ...(finalArg ? [finalArg] : [])], {
    encoding: 'utf8', input: input === undefined ? undefined : JSON.stringify(input), timeout,
    maxBuffer: 16_384, env: minimalEnv(home),
  });
  check(result.status === 0 && !result.error && !result.signal, 'PLUGIN_COMMAND_FAILED');
  try { return parseJson(Buffer.from(result.stdout)); }
  catch { throw new Error('PLUGIN_COMMAND_RESPONSE_INVALID'); }
}
async function optionalFile(file, maximum) {
  try { return await readBounded(file, maximum); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function writePrivate(file, value) { await writeFile(file, JSON.stringify(value), { mode: 0o600 }); }
function parseResult(value, id) {
  keys(value, ['apiVersion', 'id', 'status', 'artifactDigest', 'error', 'updatedAt']);
  check(value.apiVersion === 1 && value.id === id && ['queued', 'building', 'verifying', 'deploying', 'ready', 'failed'].includes(value.status), 'PLUGIN_RESULT_INVALID');
  check(value.artifactDigest === null || validDigest(value.artifactDigest), 'PLUGIN_RESULT_INVALID');
  check(value.error === null || typeof value.error === 'string' && value.error.length <= 1000, 'PLUGIN_RESULT_INVALID');
  check(typeof value.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.updatedAt) && Number.isFinite(Date.parse(value.updatedAt)), 'PLUGIN_RESULT_INVALID');
  check(value.status !== 'ready' || value.artifactDigest !== null, 'PLUGIN_RESULT_INVALID');
  return value;
}
function sourceReceipt(config, configBytes) {
  const options = { encoding: 'utf8', env: minimalEnv(process.env.HOME ?? config.stateDir), maxBuffer: 16_384, timeout: 10_000 };
  const head = spawnSync('git', ['-C', config.sourceRoot, 'rev-parse', 'HEAD'], options);
  const clean = spawnSync('git', ['-C', config.sourceRoot, 'diff', '--quiet', 'HEAD'], options);
  const status = spawnSync('git', ['-C', config.sourceRoot, 'status', '--porcelain', '--untracked-files=all'], options);
  check(head.status === 0 && !head.error && /^[a-f0-9]{40}$/.test(head.stdout.trim()) && clean.status === 0 && !clean.error && status.status === 0 && !status.error && status.stdout === '', 'PLUGIN_DEPLOY_SOURCE_NOT_CLEAN');
  return { sourceRoot: config.sourceRoot, sourceRevision: head.stdout.trim(), configPath: config.deploymentConfig, configDigest: hash(configBytes) };
}
export async function runInstaller(input) {
  check(process.platform === 'linux', 'PLUGIN_RUNNER_PLATFORM_UNSUPPORTED');
  const config = parseRunnerConfig(input);
  await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
  const stateInfo = await lstat(config.stateDir);
  check(stateInfo.isDirectory() && !stateInfo.isSymbolicLink() && (stateInfo.mode & 0o077) === 0 && await realpath(config.stateDir) === resolve(config.stateDir), 'PLUGIN_RUNNER_STATE_NOT_PRIVATE');
  const lock = createServer();
  const acquired = await new Promise((resolve, reject) => {
    lock.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    lock.listen(`\0agent-plugin-runner:${hash(config.stateDir)}`, () => resolve(true));
  });
  if (!acquired) return { busy: true, inspected: 0, built: 0, ready: 0, failed: 0, deferred: 0, deployed: false };
  let cycle;
  try {
    cycle = await mkdtemp(join(config.stateDir, 'poll-'));
    const transportHome = process.env.HOME ?? config.stateDir;
    const get = async (key, maximum) => {
      check(key.startsWith(PREFIX) && !key.includes('..') && /^[a-zA-Z0-9/._-]+$/.test(key), 'PLUGIN_OBJECT_KEY_INVALID');
      const file = join(cycle, `${hash(key)}-${get.counter++}.json`);
      const response = invoke(config.transportCommand, { operation: 'get', key, file }, transportHome);
      keys(response, ['ok', 'found'], ['file']);
      check(response.ok === true && typeof response.found === 'boolean', 'PLUGIN_TRANSPORT_RESPONSE_INVALID');
      if (!response.found) { check(response.file === undefined && !await optionalFile(file, maximum), 'PLUGIN_TRANSPORT_RESPONSE_INVALID'); return null; }
      check(response.file === file, 'PLUGIN_TRANSPORT_FILE_MISMATCH');
      return readBounded(file, maximum);
    };
    get.counter = 0;
    const put = async (key, bytes, immutable = false) => {
      if (immutable) {
        const previous = await get(key, MAX_ARTIFACT_BYTES);
        if (previous !== null) { check(previous.equals(Buffer.from(bytes)), 'PLUGIN_IMMUTABLE_OBJECT_MISMATCH'); return; }
      }
      const file = join(cycle, `${hash(bytes)}.upload.json`);
      await immutableFile(file, bytes);
      const response = invoke(config.transportCommand, { operation: 'put', key, file }, transportHome);
      keys(response, ['ok', 'found'], ['file']);
      check(response.ok === true && response.found === true && (response.file === undefined || response.file === file), 'PLUGIN_TRANSPORT_RESPONSE_INVALID');
      const actual = await get(key, MAX_ARTIFACT_BYTES);
      check(actual !== null && actual.equals(Buffer.from(bytes)), 'PLUGIN_UPLOAD_VERIFICATION_FAILED');
    };
    const desiredBytes = await get(`${PREFIX}desired.json`, MAX_DESIRED_BYTES);
    if (desiredBytes === null) return { busy: false, inspected: 0, built: 0, ready: 0, failed: 0, deferred: 0, deployed: false };
    const desired = parseDesired(parseJson(desiredBytes)), desiredDigest = hash(desiredBytes);
    const summary = { busy: false, inspected: 0, built: 0, ready: 0, failed: 0, deferred: 0, deployed: false };
    const completed = new Map();
    let startedJobs = 0;
    const setStatus = async (id, status, artifactDigest = null, error = null) => {
      await put(`${PREFIX}results/${id}.json`, JSON.stringify({ apiVersion: 1, id, status, artifactDigest, error, updatedAt: new Date().toISOString() }));
    };
    const ensureArtifact = async (digest, source) => {
      const bytes = await get(`${PREFIX}artifacts/${validDigest(digest)}.json`, MAX_ARTIFACT_BYTES);
      check(bytes !== null && hash(bytes) === digest, 'PLUGIN_ARTIFACT_DIGEST_MISMATCH');
      parseArtifact(parseJson(bytes), source);
      const file = join(config.stateDir, 'artifacts', `${digest}.json`);
      await immutableFile(file, bytes);
      return file;
    };
    for (const resource of desired.plugins) {
      if (!resource.enabled) continue;
      summary.inspected++;
      const id = installationId(resource);
      const rawRequest = await get(`${PREFIX}requests/${id}.json`, 4096);
      check(rawRequest !== null, 'PLUGIN_REQUEST_UNAVAILABLE');
      const request = parseRequest(parseJson(rawRequest));
      check(request.resourceId === resource.id && request.execution === resource.execution && JSON.stringify(request.source) === JSON.stringify(canonicalSource(resource.source)), 'PLUGIN_REQUEST_SNAPSHOT_MISMATCH');
      const existingBytes = await get(`${PREFIX}results/${id}.json`, 4096);
      const existing = existingBytes === null ? null : parseResult(parseJson(existingBytes), id);
      if (existing?.status === 'failed') { summary.failed++; continue; }
      try {
        if (existing?.artifactDigest) {
          const file = await ensureArtifact(existing.artifactDigest, request.source);
          completed.set(id, { id, resourceId: resource.id, source: request.source, execution: request.execution, artifactDigest: existing.artifactDigest, file });
          continue;
        }
        if (startedJobs >= config.maxJobs) { summary.deferred++; continue; }
        startedJobs++;
        await setStatus(id, 'building');
        let artifact;
        if (request.source.kind === 'npm') artifact = await buildNpmArtifact({ source: request.source, stateDir: config.stateDir, npmCommand: config.npmCommand, esbuildModule: config.esbuildModule, typescriptModule: config.typescriptModule });
        else {
          const bytes = await get(`${PREFIX}bundles/${request.source.digest}.mjs`, MAX_ARTIFACT_BYTES);
          check(bytes !== null, 'PLUGIN_BUNDLE_UNAVAILABLE');
          artifact = await buildBundleArtifact({ source: request.source, bytes, stateDir: config.stateDir, esbuildModule: config.esbuildModule, typescriptModule: config.typescriptModule });
        }
        summary.built++;
        const bytes = Buffer.from(JSON.stringify(artifact));
        check(bytes.length <= MAX_ARTIFACT_BYTES, 'PLUGIN_BUILD_OUTPUT_LIMIT');
        const artifactDigest = hash(bytes);
        await setStatus(id, 'verifying');
        await put(`${PREFIX}artifacts/${artifactDigest}.json`, bytes, true);
        const file = await ensureArtifact(artifactDigest, request.source);
        await setStatus(id, 'verifying', artifactDigest);
        completed.set(id, { id, resourceId: resource.id, source: request.source, execution: request.execution, artifactDigest, file });
      } catch (error) {
        if (/^PLUGIN_(?:COMMAND_|TRANSPORT_|UPLOAD_)/.test(error.message)) throw error;
        summary.failed++;
        const message = typeof error.message === 'string' && /^PLUGIN_[A-Z_]+$/.test(error.message) ? error.message : 'PLUGIN_BUILD_FAILED';
        await setStatus(id, 'failed', null, message);
      }
    }
    const latest = await get(`${PREFIX}desired.json`, MAX_DESIRED_BYTES);
    check(latest !== null && hash(latest) === desiredDigest, 'PLUGIN_DESIRED_SNAPSHOT_CHANGED');
    for (const job of completed.values()) if (job.execution === 'dynamic') { await setStatus(job.id, 'ready', job.artifactDigest); summary.ready++; }
    const hostResources = desired.plugins.filter(value => value.enabled && value.execution === 'host');
    const hostJobs = [...completed.values()].filter(value => value.execution === 'host').sort((a, b) => a.id.localeCompare(b.id));
    if (hostJobs.length !== hostResources.length) return summary;
    const activeFile = join(config.stateDir, 'active-host-manifest.json');
    const activeBytes = await optionalFile(activeFile, MAX_ARTIFACT_BYTES);
    if (hostJobs.length === 0 && activeBytes === null) return summary;
    const deploymentConfigBytes = await readBounded(config.deploymentConfig, MAX_ARTIFACT_BYTES);
    const deployment = sourceReceipt(config, deploymentConfigBytes);
    const installations = hostJobs.map(({ file, ...job }) => job);
    const artifacts = [...new Map(hostJobs.map(value => [value.artifactDigest, { digest: value.artifactDigest, file: value.file }])).values()].sort((a, b) => a.digest.localeCompare(b.digest));
    const hostKey = hash(JSON.stringify({ deployment, installations }));
    if (activeBytes !== null) {
      const active = parseJson(activeBytes);
      keys(active, ['apiVersion', 'hostKey', 'manifestDigest']);
      check(active.apiVersion === 1 && validDigest(active.hostKey) && validDigest(active.manifestDigest), 'PLUGIN_HOST_RECEIPT_INVALID');
      if (active.hostKey === hostKey) {
        for (const job of hostJobs) { await setStatus(job.id, 'ready', job.artifactDigest); summary.ready++; }
        return summary;
      }
    }
    const manifest = { apiVersion: 1, desired: { revision: desired.revision, digest: desiredDigest }, deployment, installations, artifacts };
    const manifestBytes = Buffer.from(JSON.stringify(manifest)), manifestDigest = hash(manifestBytes);
    const manifestFile = join(config.stateDir, `host-${manifestDigest}.json`);
    await immutableFile(manifestFile, manifestBytes);
    const attempt = join(config.stateDir, `deploy-${manifestDigest}.attempt.json`);
    check(await optionalFile(attempt, 4096) === null, 'PLUGIN_HOST_DEPLOYMENT_UNVERIFIED');
    for (const artifact of artifacts) check(hash(await readBounded(artifact.file, MAX_ARTIFACT_BYTES)) === artifact.digest, 'PLUGIN_ARTIFACT_DIGEST_MISMATCH');
    const immediatelyBefore = await get(`${PREFIX}desired.json`, MAX_DESIRED_BYTES);
    check(immediatelyBefore !== null && hash(immediatelyBefore) === desiredDigest, 'PLUGIN_DESIRED_SNAPSHOT_CHANGED');
    check(JSON.stringify(sourceReceipt(config, await readBounded(config.deploymentConfig, MAX_ARTIFACT_BYTES))) === JSON.stringify(deployment), 'PLUGIN_DEPLOY_TARGET_CHANGED');
    for (const job of hostJobs) await setStatus(job.id, 'deploying', job.artifactDigest);
    await writeFile(attempt, JSON.stringify({ apiVersion: 1, manifestDigest, startedAt: new Date().toISOString() }), { flag: 'wx', mode: 0o600 });
    let accepted = false;
    try {
      const response = invoke(config.deployCommand, undefined, transportHome, 30 * 60_000, manifestFile);
      keys(response, ['ok', 'accepted', 'manifestDigest']);
      check(response.ok === true && response.accepted === true && response.manifestDigest === manifestDigest, 'PLUGIN_DEPLOY_RECEIPT_MISMATCH');
      accepted = true;
    } catch {
      if (hostJobs.length === 0) summary.failed++;
      for (const job of hostJobs) { await setStatus(job.id, 'failed', job.artifactDigest, 'PLUGIN_HOST_DEPLOYMENT_UNVERIFIED'); summary.failed++; }
    }
    if (accepted) {
      await writePrivate(activeFile, { apiVersion: 1, hostKey, manifestDigest });
      summary.deployed = true;
      for (const job of hostJobs) { await setStatus(job.id, 'ready', job.artifactDigest); summary.ready++; }
    }
    return summary;
  } finally {
    try { if (cycle) await rm(cycle, { recursive: true, force: true }); }
    finally { await new Promise((resolve, reject) => lock.close(error => error ? reject(error) : resolve())); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, once: { type: 'boolean' } } });
    check(values.config, 'PLUGIN_RUNNER_CONFIG_REQUIRED');
    const config = parseRunnerConfig(parseJson(await readBounded(resolve(values.config), 32_768)));
    do {
      process.stdout.write(JSON.stringify(await runInstaller(config)) + '\n');
      if (!values.once) await new Promise(resolve => setTimeout(resolve, config.pollSeconds * 1000));
    } while (!values.once);
  } catch (error) {
    process.stderr.write((typeof error.message === 'string' && /^PLUGIN_[A-Z_]+$/.test(error.message) ? error.message : 'PLUGIN_INSTALLER_FAILED') + '\n');
    process.exitCode = 1;
  }
}
