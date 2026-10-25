import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepare } from '../scripts/prepare.mjs';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pinnedSource = fileURLToPath(new URL('../.upstream/cloudflare-os', import.meta.url));
test('the full reviewed patch stack composes against the cached pinned upstream', {
  skip: !existsSync(join(pinnedSource, '.git')) && 'Run prepare once to fetch the pinned upstream',
}, async () => {
  const checkout = await prepare({ source: pinnedSource });
  const agent = await readFile(join(checkout, 'packages/workshop-backend/src/agent.ts'), 'utf8');
  assert.match(agent, /tools\.searchBotMemory = defineTool/);
  assert.match(await readFile(join(checkout, 'packages/workshop-frontend/src/ChatInterface.tsx'), 'utf8'),
    /case "searchBotMemory": return "Searching bot memory"/);
});

test('prepare pins source, applies reviewed overlays once and leaves source untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-agent-os-prepare-'));
  try {
    const source = join(dir, 'source');
    const root = join(dir, 'wrapper');
    await mkdir(source);
    const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init', '--quiet');
    await writeFile(join(source, 'upstream.txt'), 'original\n');
    git('add', 'upstream.txt');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Fixture');
    const commit = git('rev-parse', 'HEAD');
    await mkdir(join(root, 'gatekeeper-oidc'), { recursive: true });
    await mkdir(join(root, 'patches'));
    await mkdir(join(root, 'overlay/packages/workshop-backend/src'), { recursive: true });
    await writeFile(join(root, 'upstream.json'), JSON.stringify({
      repository: 'https://github.com/cloudflare/cloudflare-os.git', commit,
    }));
    await writeFile(join(root, 'gatekeeper-oidc/wrangler.jsonc'), '{"main":"src/index.ts"}');
    await writeFile(join(root, 'overlay/packages/workshop-backend/src/model.ts'), 'export const model = true;\n');
    await writeFile(join(root, 'patches/model.patch'),
      'diff --git a/upstream.txt b/upstream.txt\n--- a/upstream.txt\n+++ b/upstream.txt\n@@ -1 +1 @@\n-original\n+patched\n');
    const checkout = await prepare({ source, root });
    assert.equal(await readFile(join(checkout, 'upstream.txt'), 'utf8'), 'patched\n');
    assert.equal(await readFile(join(source, 'upstream.txt'), 'utf8'), 'original\n');
    assert.equal(git('status', '--porcelain'), '');
    assert.match(await readFile(join(checkout, 'packages/gatekeeper-oidc/wrangler.jsonc'), 'utf8'), /src\/index.ts/);
    assert.match(await readFile(join(checkout, 'packages/workshop-backend/src/model.ts'), 'utf8'), /model = true/);
    assert.equal(await prepare({ source, root }), checkout);
    await writeFile(join(source, 'upstream.txt'), 'unreviewed edit\n');
    await assert.rejects(prepare({ source, root }), /git failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
