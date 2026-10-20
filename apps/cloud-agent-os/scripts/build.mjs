import assert from 'node:assert/strict';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { buildCommands, deploymentOrder, generateConfigs, packages, parseDeployment, requiresOidcSecret } from './config.mjs';
import { prepare, run, wrapperRoot } from './prepare.mjs';
import { applyHostInventory, parseHostManifest } from './apply-host-plugin-inventory.mjs';
import { applyUploadOverlay, captureBuildInputs, clonePreparedCheckout, createArtifactDirectory, digest, exportWorkerArtifact, finalizeArtifactManifest } from './frozen-artifacts.mjs';

const { values } = parseArgs({ options: {
  config: { type: 'string' }, source: { type: 'string' },
  'oidc-secrets': { type: 'string' },
  'plugin-inventory': { type: 'string' }, 'artifact-dir': { type: 'string' },
  'upload-config-overlay': { type: 'string' },
  check: { type: 'boolean' }, deploy: { type: 'boolean' }, plan: { type: 'boolean' },
} });

try {
  assert(values.config, 'Pass --config <private deployment.json>');
  assert([values.check, values.deploy, values.plan].filter(Boolean).length === 1,
    'Choose exactly one of --check, --deploy, or --plan');
  assert(!values['plugin-inventory'] || values.check && values['artifact-dir'], '--plugin-inventory requires --check and --artifact-dir');
  assert(!values['artifact-dir'] || values.check, '--artifact-dir requires --check');
  assert(!values['upload-config-overlay'] || values.check && values['artifact-dir'], '--upload-config-overlay requires --check and --artifact-dir');
  const deploymentBytes = await readFile(resolve(values.config));
  const config = parseDeployment(JSON.parse(deploymentBytes.toString('utf8')));
  const oidcSecrets = values['oidc-secrets'] ? resolve(values['oidc-secrets']) : undefined;
  assert(config.auth.mode !== 'access' || !oidcSecrets, '--oidc-secrets requires OIDC authentication');
  assert(requiresOidcSecret(config) || !oidcSecrets, '--oidc-secrets requires confidential-client authentication');
  if (values.deploy && requiresOidcSecret(config)) {
    assert(oidcSecrets, '--deploy requires --oidc-secrets <private secret JSON or env file>');
    const metadata = await stat(oidcSecrets);
    assert(metadata.isFile() && metadata.size > 0 && (metadata.mode & 0o077) === 0,
      'The OIDC secrets file must be nonempty and accessible only by its owner');
  } else assert(!oidcSecrets, '--oidc-secrets is only used with --deploy');
  const order = deploymentOrder(config);
  if (values.plan) {
    console.log(JSON.stringify({ upstream: 'upstream.json', order, builds: buildCommands(config) }, null, 2));
  } else {
    const sourceRoot = values['artifact-dir'] ? run('git', ['rev-parse', '--show-toplevel'], { cwd: wrapperRoot, encoding: 'utf8', stdio: 'pipe' }) : undefined;
    const inputs = values['artifact-dir'] ? await captureBuildInputs({ sourceRoot, configFile: values.config, pluginInventory: values['plugin-inventory'], overlayFile: values['upload-config-overlay'] }) : undefined;
    if (inputs) assert(inputs.deployment.sha256 === digest(deploymentBytes), 'Deployment configuration changed');
    const preparedCheckout = await prepare({ source: values.source });
    const artifactDir = inputs ? await createArtifactDirectory(values['artifact-dir'], [sourceRoot, preparedCheckout]) : undefined;
    const isolated = artifactDir ? await clonePreparedCheckout({ checkout: preparedCheckout, parent: dirname(artifactDir) }) : undefined;
    const checkout = isolated?.checkout ?? preparedCheckout;
    if (values['plugin-inventory']) {
      const inventoryBytes = await readFile(resolve(values['plugin-inventory']));
      assert(digest(inventoryBytes) === inputs.pluginInventory.sha256, 'Plugin inventory changed');
      const manifest = parseHostManifest(JSON.parse(inventoryBytes.toString('utf8')));
      assert(manifest.deployment.sourceRoot === inputs.sourceRoot && manifest.deployment.sourceRevision === inputs.sourceRevision
        && manifest.deployment.configPath === inputs.deployment.path && manifest.deployment.configDigest === inputs.deployment.sha256, 'Plugin inventory deployment identity changed');
      await applyHostInventory({ manifestFile: resolve(values['plugin-inventory']), checkout });
    }
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
    const overlayBytes = values['upload-config-overlay'] ? await readFile(resolve(values['upload-config-overlay'])) : undefined;
    if (overlayBytes) assert(digest(overlayBytes) === inputs.overlay.sha256, 'Upload tuning changed');
    const baseGenerated = generateConfigs(config, bases);
    const overlay = overlayBytes ? JSON.parse(overlayBytes.toString('utf8')) : undefined;
    const generated = applyUploadOverlay(baseGenerated, overlay);
    const paths = order.map(key => join(checkout, packages[key], 'wrangler.cloud-agent-os.jsonc'));
    try {
      for (const [index, key] of order.entries()) {
        await writeFile(paths[index], JSON.stringify(generated[key], null, 2) + '\n', { mode: 0o600 });
      }
      for (const { args, env } of buildCommands(config)) {
        run('pnpm', args, { cwd: checkout, env: { ...process.env, ...env } });
      }
      if (values.check) {
        if (config.auth.mode !== 'access') {
          run(process.execPath, [join(checkout, packages.oidc, 'tests/check.mjs'), checkout], { cwd: checkout });
          run(process.execPath, [join(checkout, packages.oidc, 'tests/check.mjs'), checkout, 'oauth-jwt'], { cwd: checkout });
          run(process.execPath, [join(checkout, packages.oidc, 'tests/check.mjs'), checkout, 'oauth-jwt-service'], { cwd: checkout });
          for (const failure of ['', 'session', 'no-email', 'signups-disabled']) {
            run(process.execPath, [join(checkout, packages.oidc, 'tests/workshop-handoff.mjs'), checkout, failure], { cwd: checkout });
          }
        }
        if (config.mcp) run('pnpm', ['exec', 'vitest', 'run', '__tests__/account-endpoint.test.ts'], {
          cwd: join(checkout, 'packages/mcp-shared'),
        });
        run('pnpm', ['exec', 'vitest', 'run',
          ...(config.auth.mode === 'access' ? ['__tests__/access.test.ts', '__tests__/client-errors.test.ts'] : []),
          '__tests__/subscription-models.test.ts', '__tests__/subscription-setup-session.test.ts',
          '__tests__/admin-config.test.ts', '__tests__/ai-gateway.test.ts',
          '__tests__/pending-login.test.ts', '__tests__/redirect-login.test.ts',
          '__tests__/user-models.test.ts', '__tests__/admin-settings-models.test.ts',
          '__tests__/site-launch.test.ts', '__tests__/site-launch-agent.test.ts',
          '__tests__/opencode-loop.test.ts', '__tests__/agent-retry.test.ts',
          '__tests__/agent-settings.test.ts', '__tests__/scoped-models.test.ts',
          '__tests__/scoped-agent-resources.test.ts', '__tests__/agent-principal.test.ts',
          '__tests__/agent-plugin-artifacts.test.ts', '__tests__/agent-plugin-runtime.test.ts',
          '__tests__/agent-package-loop.test.ts', '__tests__/agent-plugin-budget.test.ts',
          '__tests__/subscription-binding-catalog.test.ts',
          '__tests__/spawned-agent-tools.test.ts', '__tests__/overseer-hooks.test.ts',
          '__tests__/chat-model-data.test.ts', '__tests__/agent-compaction.test.ts',
          '__tests__/chat-changes.test.ts', '__tests__/worktree-session.test.ts',
          '__tests__/worktrees.test.ts'], {
          cwd: join(checkout, packages.workshop),
        });
        run('pnpm', ['exec', 'vitest', 'run',
          'src/useAuth.test.tsx', 'src/redirectLogin.test.tsx',
          'src/ConnectHandoffPage.test.tsx', 'src/components/auth/OAuthButtons.test.tsx',
          'src/AddModelModal.test.tsx',
          'src/features/ai-models/AdminModelsPanel.test.tsx',
          'src/features/ai-models/AdminModelsPanel.subscription.test.tsx',
          'src/features/ai-models/SubscriptionDashboard.test.tsx',
          'src/routes/-providers.test.tsx', 'src/OnboardingWizard.test.tsx',
          'src/features/agent-settings/AgentSettingsPanel.test.tsx',
          'src/ChatInterface.actions.test.tsx', 'src/ChatInterface.compaction.test.ts',
          'src/BlueprintLandingPage.test.tsx',
          'src/features/chat/composer/ComposerModelSelector.test.tsx',
          'src/features/chat/composer/ChatComposer.test.tsx', 'src/homePromptFlow.test.tsx',
          'src/features/site-launch/siteLaunch.test.ts',
          'src/features/site-launch/SiteLaunchPage.test.tsx',
          'src/features/site-launch/WorkspaceSiteContext.test.tsx',
          'src/features/site-launch/SiteLaunchScope.test.tsx',
          'src/features/site-launch/SiteLaunchRoot.test.tsx',
          'src/features/site-launch/workspaceExit.test.ts',
          'src/rootRoute.test.tsx', 'src/components/WorkspaceOpenErrorPage.test.tsx',
          'src/GadgetEditor.blueprintUpdate.test.tsx'], {
          cwd: join(checkout, 'packages/workshop-frontend'),
        });
      }
      const workers = [];
      const esbuild = artifactDir ? createRequire(requireUpstream.resolve('wrangler'))('esbuild') : undefined;
      for (const key of order) {
        const outDir = artifactDir ? join(artifactDir, 'workers', key, 'modules') : undefined;
        run('pnpm', ['exec', 'wrangler', 'deploy', '--config', 'wrangler.cloud-agent-os.jsonc',
          ...(values.check ? ['--dry-run'] : []),
          ...(outDir ? ['--outdir', outDir] : []),
          ...(key === 'oidc' && oidcSecrets ? ['--secrets-file', oidcSecrets] : [])], {
          cwd: join(checkout, packages[key]),
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: config.accountId },
        });
        if (artifactDir) {
          const selected = overlay?.workers?.[key]?.preserveServiceBindings ?? [];
          const preservedServiceBindings = (baseGenerated[key].services ?? []).filter(service => selected.includes(service.binding));
          workers.push(await exportWorkerArtifact({ artifactDir, key, packageDir: join(checkout, packages[key]), original: generated[key], esbuild, preservedServiceBindings }));
        }
      }
      if (artifactDir) {
        const prepared = JSON.parse(await readFile(join(dirname(checkout), 'prepared.json'), 'utf8'));
        const receipt = await finalizeArtifactManifest({ artifactDir, inputs, prepared, workers });
        console.log(JSON.stringify({ ok: true, checked: true, ...receipt }));
      }
    } finally {
      await Promise.all(paths.map(path => rm(path, { force: true })));
      if (isolated) await rm(isolated.temporary, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
