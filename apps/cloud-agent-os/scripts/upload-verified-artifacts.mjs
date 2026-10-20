import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { markUploadAttempt, verifyArtifactManifest } from './frozen-artifacts.mjs';

const check = (value, code) => assert(value, code);
export function uploadedVersion(stdout) {
  const matches = [...stdout.replace(/\x1b\[[0-9;]*m/g, '').matchAll(/^Current Version ID:\s*([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\s*$/gm)];
  check(matches.length === 1, 'ARTIFACT_UPLOAD_VERSION_UNVERIFIED');
  return matches[0][1];
}
const outside = (parent, child) => { const value = relative(parent, child); return value === '..' || value.startsWith(`..${sep}`) || isAbsolute(value); };

/** Upload checked bytes only. execute is injectable for a local, non-network verification. */
export async function uploadVerifiedArtifacts({ artifactDir, manifestDigest, configFile, attemptMarker, wranglerFile, workers, execute }) {
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
    check(help.status === 0 && !help.error && help.stdout.includes('--config'), 'ARTIFACT_WRANGLER_CAPABILITY_UNVERIFIED');
    execute = async configPath => {
      const result = spawnSync(process.execPath, [wranglerFile, 'deploy', '--config', configPath], { env, encoding: 'utf8', timeout: 10 * 60_000, maxBuffer: 1024 * 1024 });
      check(result.status === 0 && !result.error && !result.signal, 'ARTIFACT_UPLOAD_UNVERIFIED');
      return uploadedVersion(result.stdout);
    };
  }
  // No real upload happens before this exclusive, fsynced marker. Never remove it on failure.
  await markUploadAttempt(attemptMarker, { apiVersion: 1, manifestDigest, workers: targets.map(value => value.key), startedAt: new Date().toISOString() });
  const workerVersions = {};
  for (const worker of targets) {
    await verifyArtifactManifest({ artifactDir, manifestDigest });
    const versionId = await execute(join(artifactDir, worker.config));
    check(typeof versionId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(versionId), 'ARTIFACT_UPLOAD_VERSION_UNVERIFIED');
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
