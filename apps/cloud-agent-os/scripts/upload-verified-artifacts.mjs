import assert from 'node:assert/strict';
import { provisionFrozenNativeMemory } from './native-memory-config.mjs';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { markUploadAttempt, verifyArtifactManifest } from './frozen-artifacts.mjs';

const check = (value, code) => assert(value, code);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

async function inheritanceRead(url, fetchImpl, allowNullErrors = false) {
  check(Boolean(process.env.CLOUDFLARE_API_TOKEN), 'ARTIFACT_INHERITANCE_TOKEN_REQUIRED');
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, Accept: 'application/json' } });
  check(response.status === 200 && !response.redirected, 'ARTIFACT_INHERITANCE_HTTP_UNVERIFIED');
  const contentType = response.headers.get('content-type');
  check(contentType && /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType), 'ARTIFACT_INHERITANCE_ENCODING_INVALID');
  const maximum = 2 * 1024 * 1024, declared = response.headers.get('content-length');
  check(declared === null || (/^\d+$/.test(declared) && Number(declared) <= maximum), 'ARTIFACT_INHERITANCE_BODY_LIMIT');
  check(response.body, 'ARTIFACT_INHERITANCE_JSON_INVALID');
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '', size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maximum) { await reader.cancel(); throw new Error('ARTIFACT_INHERITANCE_BODY_LIMIT'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  } finally { reader.releaseLock(); }
  let envelope;
  try { envelope = JSON.parse(text); } catch { throw new Error('ARTIFACT_INHERITANCE_JSON_INVALID'); }
  // Cloudflare/api-schemas#47: successful Workers Versions responses can contain explicit null.
  check(object(envelope) && envelope.success === true && ((Array.isArray(envelope.errors) && envelope.errors.length === 0)
    || (allowNullErrors && envelope.errors === null)) && object(envelope.result), 'ARTIFACT_INHERITANCE_RESPONSE_INVALID');
  return envelope.result;
}

/** Check visible identity only; opaque service props are retained by Cloudflare's native inherit. */
export async function verifyInheritedServiceBindings({ accountId, worker, fetchImpl = fetch }) {
  const preserved = worker.preservedServiceBindings ?? [];
  if (preserved.length === 0) return;
  check(/^[a-f0-9]{32}$/.test(accountId) && typeof worker.name === 'string' && /^[a-zA-Z0-9_-]+$/.test(worker.name), 'ARTIFACT_INHERITANCE_TARGET_INVALID');
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${encodeURIComponent(worker.name)}`;
  const settings = await inheritanceRead(`${base}/settings`, fetchImpl);
  check(Array.isArray(settings.bindings), 'ARTIFACT_INHERITANCE_BINDINGS_INVALID');
  for (const expected of preserved) {
    const matches = settings.bindings.filter(binding => object(binding) && binding.name === expected.binding);
    check(matches.length === 1 && matches[0].type === 'service' && matches[0].service === expected.service,
      'ARTIFACT_INHERITANCE_IDENTITY_CHANGED');
    for (const key of ['entrypoint', 'environment']) if (Object.hasOwn(expected, key)) {
      check(typeof expected[key] === 'string' && matches[0][key] === expected[key], 'ARTIFACT_INHERITANCE_IDENTITY_CHANGED');
    }
  }
  const deployments = await inheritanceRead(`${base}/deployments`, fetchImpl);
  const active = Array.isArray(deployments.deployments) && deployments.deployments[0];
  check(object(active) && Array.isArray(active.versions) && active.versions.length === 1
    && object(active.versions[0]) && active.versions[0].percentage === 100 && uuid(active.versions[0].version_id), 'ARTIFACT_INHERITANCE_ACTIVE_VERSION_UNVERIFIED');
  // Legacy inherit selects the latest uploaded version, which may be staged and inactive.
  const versions = await inheritanceRead(`${base}/versions`, fetchImpl, true);
  check(Array.isArray(versions.items) && object(versions.items[0]) && uuid(versions.items[0].id)
    && versions.items[0].id === active.versions[0].version_id, 'ARTIFACT_INHERITANCE_LATEST_NOT_ACTIVE');
}

/** Keep the final target check adjacent to each upload, including uploads after the first worker. */
export async function uploadVerifiedWorker({ accountId, worker, configPath, execute, fetchImpl }) {
  await verifyInheritedServiceBindings({ accountId, worker, fetchImpl });
  const versionId = await execute(configPath);
  check(uuid(versionId), 'ARTIFACT_UPLOAD_VERSION_UNVERIFIED');
  return versionId;
}
export function uploadedVersion(stdout) {
  const matches = [...stdout.replace(/\x1b\[[0-9;]*m/g, '').matchAll(/^Current Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\s*$/gm)];
  check(matches.length === 1, 'ARTIFACT_UPLOAD_VERSION_UNVERIFIED');
  return matches[0][1];
}
const outside = (parent, child) => { const value = relative(parent, child); return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value); };

/** Keep Wrangler's writable project scratch outside the sealed artifact tree. */
export async function runFrozenWrangler({ wranglerFile, configPath, env, dryRun = false, temporaryRoot = tmpdir() }) {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  check(isAbsolute(config.main), 'ARTIFACT_MAIN_PATH_INVALID');
  const scratch = await mkdtemp(join(temporaryRoot, 'cloud-agent-os-upload-'));
  try {
    // An explicit identical main makes Wrangler use cwd for its temporary project files.
    const result = spawnSync(process.execPath, [wranglerFile, 'deploy', config.main, '--config', configPath,
      '--cwd', scratch, '--outdir', join(scratch, 'out'), ...(dryRun ? ['--dry-run'] : [])], {
      cwd: scratch, env, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 1024 * 1024,
    });
    check(result.status === 0 && !result.error && !result.signal, 'ARTIFACT_UPLOAD_UNVERIFIED');
    return result.stdout;
  } finally {
    // This exact directory was created above; frozen modules and configuration stay untouched.
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Upload checked bytes only. execute is injectable for a local, non-network verification. */
export async function uploadVerifiedArtifacts({ artifactDir, manifestDigest, configFile, attemptMarker, wranglerFile, workers, execute, fetchImpl }) {
  artifactDir = resolve(artifactDir);
  const manifest = await verifyArtifactManifest({ artifactDir, manifestDigest });
  check(resolve(configFile) === manifest.inputs.deployment.path, 'ARTIFACT_DEPLOYMENT_CONFIG_CHANGED');
  const selected = workers ?? manifest.workers.map(worker => worker.key);
  check(selected.length > 0 && new Set(selected).size === selected.length && selected.every(key => manifest.workers.some(worker => worker.key === key)), 'ARTIFACT_WORKERS_INVALID');
  // Selection preserves the verified deployment order even when a caller requests a subset.
  const targets = manifest.workers.filter(worker => selected.includes(worker.key));
  attemptMarker = resolve(attemptMarker);
  check(outside(artifactDir, attemptMarker) && outside(manifest.inputs.sourceRoot, attemptMarker), 'ARTIFACT_ATTEMPT_LOCATION_INVALID');
  const configs = await Promise.all(targets.map(async worker => JSON.parse(await readFile(join(artifactDir, worker.config), 'utf8'))));
  check(configs.every(config => typeof config.account_id === 'string' && config.account_id === configs[0].account_id), 'ARTIFACT_ACCOUNT_INVALID');
  if (!execute) {
    check(isAbsolute(wranglerFile), 'ARTIFACT_WRANGLER_PATH_REQUIRED');
    const info = await lstat(wranglerFile);
    check(info.isFile() && !info.isSymbolicLink() && await realpath(wranglerFile) === resolve(wranglerFile), 'ARTIFACT_WRANGLER_INVALID');
    check(Boolean(process.env.CLOUDFLARE_API_TOKEN) && (!process.env.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID === configs[0].account_id), 'ARTIFACT_DEPLOYMENT_ENV_INVALID');
    const env = Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'NODE_EXTRA_CA_CERTS', 'CLOUDFLARE_API_TOKEN'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    Object.assign(env, { CLOUDFLARE_ACCOUNT_ID: configs[0].account_id, WRANGLER_SEND_METRICS: 'false', CI: 'true' });
    const help = spawnSync(process.execPath, [wranglerFile, 'deploy', '--help'], { env, encoding: 'utf8', timeout: 30_000, maxBuffer: 256_000 });
    check(help.status === 0 && !help.error && ['--config', '--cwd', '--outdir'].every(flag => help.stdout.includes(flag)), 'ARTIFACT_WRANGLER_CAPABILITY_UNVERIFIED');
    execute = async configPath => uploadedVersion(await runFrozenWrangler({ wranglerFile, configPath, env }));
  }
  // No real upload happens before this exclusive, fsynced marker. Never remove it on failure.
  await markUploadAttempt(attemptMarker, { apiVersion: 1, manifestDigest, workers: targets.map(value => value.key), startedAt: new Date().toISOString() });
  if (targets.some(worker => worker.key === 'workshop')) {
    await provisionFrozenNativeMemory({ bytes: await readFile(configFile),
      expectedDigest: manifest.inputs.deployment.sha256, accountId: configs[0].account_id, fetchImpl });
  }
  const workerVersions = {};
  for (const worker of targets) {
    await verifyArtifactManifest({ artifactDir, manifestDigest });
    const versionId = await uploadVerifiedWorker({ accountId: configs[0].account_id, worker, configPath: join(artifactDir, worker.config), execute, fetchImpl });
    workerVersions[worker.key] = versionId;
  }
  return { ok: true, accepted: true, manifestDigest, workers: targets.length, workerVersions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: {
      'artifact-dir': { type: 'string' }, 'manifest-digest': { type: 'string' }, config: { type: 'string' },
      'attempt-marker': { type: 'string' }, wrangler: { type: 'string' }, workers: { type: 'string' },
    } });
    check(values['artifact-dir'] && values['manifest-digest'] && values.config && values['attempt-marker'] && values.wrangler, 'ARTIFACT_UPLOAD_ARGUMENTS_REQUIRED');
    const result = await uploadVerifiedArtifacts({ artifactDir: values['artifact-dir'], manifestDigest: values['manifest-digest'], configFile: values.config, attemptMarker: values['attempt-marker'], wranglerFile: values.wrangler, workers: values.workers?.split(',') });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    process.stderr.write((typeof error.message === 'string' && /^ARTIFACT_[A-Z_]+$/.test(error.message) ? error.message : 'ARTIFACT_UPLOAD_UNVERIFIED') + '\n');
    process.exitCode = 1;
  }
}
