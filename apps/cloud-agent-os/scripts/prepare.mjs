import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const wrapperRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  assert(result.status === 0, `${command} failed (exit ${result.status ?? 'signal'})`);
  return typeof result.stdout === 'string' ? result.stdout.trim() : '';
}

async function overlayFiles(dir, prefix = '') {
  const files = [];
  if (!existsSync(dir)) return files;
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert(!entry.isSymbolicLink(), 'Overlay symlinks are not supported');
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await overlayFiles(join(dir, entry.name), name));
    else if (entry.isFile()) files.push([name, await readFile(join(dir, entry.name))]);
  }
  return files;
}

/** Materialize reviewed overlays in an isolated build tree; never modify the pinned source. */
export async function prepare({ source, root = wrapperRoot } = {}) {
  const pin = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'));
  assert(pin.repository === 'https://github.com/cloudflare/cloudflare-os.git', 'Unexpected upstream repository');
  assert(/^[a-f0-9]{40}$/.test(pin.commit), 'Upstream must be pinned to a full commit');
  source = resolve(source ?? join(root, '.upstream/cloudflare-os'));
  if (!existsSync(source)) {
    await mkdir(dirname(source), { recursive: true });
    run('git', ['init', source]);
    run('git', ['-C', source, 'fetch', '--depth=1', pin.repository, pin.commit]);
    run('git', ['-C', source, 'checkout', '--detach', pin.commit]);
  }
  const git = (...args) => run('git', ['-C', source, ...args], { encoding: 'utf8', stdio: 'pipe' });
  assert(git('rev-parse', 'HEAD') === pin.commit, 'Source checkout does not match upstream.json');
  git('diff', '--quiet', 'HEAD');
  const files = [];
  for (const dir of ['overlay', 'patches', 'gatekeeper-oidc']) {
    files.push(...(await overlayFiles(join(root, dir))).map(([name, bytes]) => [join(dir, name), bytes]));
  }
  assert(files.some(([name]) => name === 'gatekeeper-oidc/wrangler.jsonc'
    || name === 'overlay/packages/gatekeeper-oidc/wrangler.jsonc'), 'Missing OIDC Gatekeeper overlay');
  const hash = createHash('sha256').update(pin.commit);
  for (const [name, bytes] of files) hash.update(name).update('\0').update(bytes).update('\0');
  const overlayHash = hash.digest('hex');
  const buildRoot = join(root, '.build');
  const destination = join(buildRoot, `${pin.commit.slice(0, 12)}-${overlayHash.slice(0, 12)}`);
  const stampPath = join(destination, 'prepared.json');
  if (existsSync(stampPath)) {
    const stamp = JSON.parse(await readFile(stampPath, 'utf8'));
    assert(stamp.upstream === pin.commit && stamp.overlayHash === overlayHash, 'Build cache identity mismatch');
    return join(destination, 'cloudflare-os');
  }
  await mkdir(buildRoot, { recursive: true });
  const staging = await mkdtemp(join(buildRoot, '.prepare-'));
  try {
    const checkout = join(staging, 'cloudflare-os');
    const archive = join(staging, 'upstream.tar');
    await mkdir(checkout);
    run('git', ['-C', source, 'archive', '--format=tar', '--output', archive, pin.commit]);
    run('tar', ['-xf', archive, '-C', checkout]);
    await rm(archive);
    run('git', ['init', '--quiet', checkout]);
    if (existsSync(join(root, 'overlay'))) await cp(join(root, 'overlay'), checkout, { recursive: true });
    if (existsSync(join(root, 'gatekeeper-oidc'))) {
      assert(!existsSync(join(checkout, 'packages/gatekeeper-oidc')), 'Two OIDC Gatekeeper overlays supplied');
      await cp(join(root, 'gatekeeper-oidc'), join(checkout, 'packages/gatekeeper-oidc'), { recursive: true });
    }
    for (const [name] of files.filter(([name]) => name.startsWith('patches/') && name.endsWith('.patch'))) {
      run('git', ['-C', checkout, 'apply', '--check', join(root, name)]);
      run('git', ['-C', checkout, 'apply', join(root, name)]);
    }
    await writeFile(join(staging, 'prepared.json'), JSON.stringify({ upstream: pin.commit, overlayHash }, null, 2) + '\n');
    await rename(staging, destination);
    return join(destination, 'cloudflare-os');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { source: { type: 'string' } } });
    console.log(await prepare({ source: values.source }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
