import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildCommands, generateConfigs, packages, parseDeployment } from './config.mjs';
import { prepare, run } from './prepare.mjs';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, source: { type: 'string' },
  'oidc-secrets': { type: 'string' },
  check: { type: 'boolean' }, deploy: { type: 'boolean' }, plan: { type: 'boolean' },
} });

try {
  assert(values.config, 'Pass --config <private deployment.json>');
  assert([values.check, values.deploy, values.plan].filter(Boolean).length === 1,
    'Choose exactly one of --check, --deploy, or --plan');
  const config = parseDeployment(JSON.parse(await readFile(resolve(values.config), 'utf8')));
  const oidcSecrets = values['oidc-secrets'] ? resolve(values['oidc-secrets']) : undefined;
  if (values.deploy) {
    assert(oidcSecrets, '--deploy requires --oidc-secrets <private secret JSON or env file>');
    const metadata = await stat(oidcSecrets);
    assert(metadata.isFile() && metadata.size > 0 && (metadata.mode & 0o077) === 0,
      'The OIDC secrets file must be nonempty and accessible only by its owner');
  } else assert(!oidcSecrets, '--oidc-secrets is only used with --deploy');
  const order = Object.keys(packages).filter(key => key !== 'mcp' || config.mcp);
  if (values.plan) {
    console.log(JSON.stringify({ upstream: 'upstream.json', order, builds: buildCommands(config) }, null, 2));
  } else {
    const checkout = await prepare({ source: values.source });
    // The new workspace package reuses existing upstream dependencies. Its importer is added to
    // the disposable lockfile; upstream's tracked lockfile is never changed.
    run('pnpm', ['install', '--no-frozen-lockfile'], { cwd: checkout });
    const requireUpstream = createRequire(join(checkout, 'scripts/package.json'));
    const { parse, printParseErrorCode } = requireUpstream('jsonc-parser');
    const bases = {};
    for (const key of order) {
      const errors = [];
      bases[key] = parse(await readFile(join(checkout, packages[key], 'wrangler.jsonc'), 'utf8'), errors,
        { allowTrailingComma: true });
      assert(errors.length === 0, `${key} Wrangler JSONC: ${errors.map(error => printParseErrorCode(error.error)).join(', ')}`);
    }
    const generated = generateConfigs(config, bases);
    const paths = order.map(key => join(checkout, packages[key], 'wrangler.cloud-agent-os.jsonc'));
    try {
      for (const [index, key] of order.entries()) {
        await writeFile(paths[index], JSON.stringify(generated[key], null, 2) + '\n', { mode: 0o600 });
      }
      for (const { args, env } of buildCommands(config)) {
        run('pnpm', args, { cwd: checkout, env: { ...process.env, ...env } });
      }
      if (values.check) {
        run(process.execPath, [join(checkout, packages.oidc, 'tests/check.mjs'), checkout], { cwd: checkout });
        if (config.mcp) run('pnpm', ['exec', 'vitest', 'run', '__tests__/account-endpoint.test.ts'], {
          cwd: join(checkout, 'packages/mcp-shared'),
        });
        run('pnpm', ['exec', 'vitest', 'run', '__tests__/subscription-models.test.ts',
          '__tests__/user-models.test.ts', '__tests__/admin-settings-models.test.ts'], {
          cwd: join(checkout, packages.workshop),
        });
        run('pnpm', ['exec', 'vitest', 'run', 'src/AddModelModal.test.tsx',
          'src/features/ai-models/AdminModelsPanel.test.tsx',
          'src/features/ai-models/AdminModelsPanel.subscription.test.tsx',
          'src/routes/-providers.test.tsx', 'src/OnboardingWizard.test.tsx',
          'src/BlueprintLandingPage.test.tsx',
          'src/features/chat/composer/ComposerModelSelector.test.tsx', 'src/homePromptFlow.test.tsx'], {
          cwd: join(checkout, 'packages/workshop-frontend'),
        });
      }
      for (const key of order) {
        run('pnpm', ['exec', 'wrangler', 'deploy', '--config', 'wrangler.cloud-agent-os.jsonc',
          ...(values.check ? ['--dry-run'] : []),
          ...(key === 'oidc' && oidcSecrets ? ['--secrets-file', oidcSecrets] : [])], {
          cwd: join(checkout, packages[key]),
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId },
        });
      }
    } finally {
      await Promise.all(paths.map(path => rm(path, { force: true })));
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
