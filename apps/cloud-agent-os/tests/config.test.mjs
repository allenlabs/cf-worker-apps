import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildCommands, generateConfigs, packages, parseDeployment } from '../scripts/config.mjs';

const example = JSON.parse(await readFile(new URL('../deployment.example.json', import.meta.url), 'utf8'));
const bases = Object.fromEntries(Object.keys(packages).map(key => [key, {
  main: 'src/index.ts', workers_dev: true, preview_urls: true,
  routes: [{ pattern: 'old.example.com' }],
  migrations: [{ tag: 'v0', new_sqlite_classes: ['ExistingObject'] }],
  vars: { CF_ACCESS_AUD: 'old', CF_ACCESS_ISS: 'https://old.example.com' },
  ...(key === 'router' ? { assets: { binding: 'ASSETS', directory: '../workshop-frontend/dist' } } : {}),
} ]));

test('native SSO is the only sign-in path; router alone owns a public custom domain', () => {
  const configs = generateConfigs(example, bases);
  assert.equal(configs.workshop.vars.AUTH_GATEKEEPERS, 'oidc');
  assert.equal(configs.workshop.vars.DISABLE_PASSWORD_AUTH, 'true');
  assert.equal(configs.workshop.vars.CF_ACCESS_AUD, undefined);
  assert.equal(configs.workshop.vars.CF_ACCESS_ISS, undefined);
  assert.equal(buildCommands(example).find(step => step.env.VITE_CF_ACCESS_MODE)?.env.VITE_CF_ACCESS_MODE, 'false');
  assert.equal(buildCommands(example).find(step => step.env.VITE_CODEX_BRIDGE_MODEL)?.env.VITE_CODEX_BRIDGE_MODEL,
    example.modelBridge.model);
  assert.deepEqual(configs.router.routes, [{ pattern: 'os.example.com', custom_domain: true }]);
  for (const [key, config] of Object.entries(configs)) {
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    if (key !== 'router') assert.deepEqual(config.routes, []);
    assert.deepEqual(config.migrations, bases[key].migrations);
  }
  assert.equal(configs.router.assets.binding, 'ASSETS');
  assert.equal(configs.workshop.assets, undefined);
  assert(configs.router.services.some(binding => binding.binding === 'GATEKEEPER_OIDC' && !binding.entrypoint));
  assert(configs.workshop.services.some(binding => binding.binding === 'GATEKEEPER_OIDC' && binding.entrypoint === 'GatekeeperVendor'));
  assert.deepEqual(configs.oidc.secrets.required, ['OIDC_CLIENT_SECRET']);
});

test('storage, model service and optional MCP remain explicit', () => {
  const configs = generateConfigs(example, bases);
  assert.equal(configs.workshop.kv_namespaces[0].id, example.resources.blueprintsKvNamespaceId);
  assert.equal(configs.context.kv_namespaces[0].id, example.resources.contextKvNamespaceId);
  assert.equal(configs.workshop.r2_buckets[0].bucket_name, example.resources.blueprintContentBucket);
  assert.equal(configs.workshop.services.find(binding => binding.binding === 'CODEX_BRIDGE').entrypoint, 'CloudAgentInference');
  assert.equal(configs.mcp.vars.MCP_ALLOW_INSECURE, 'false');
  const scoped = structuredClone(example);
  scoped.mcpScopes = { 'https://mcp.example.com/team/mcp': ['openid', 'example.read'] };
  assert.deepEqual(JSON.parse(generateConfigs(scoped, bases).mcp.vars.MCP_OAUTH_SCOPES), scoped.mcpScopes);
  const noMcp = structuredClone(example);
  noMcp.mcp = false;
  delete noMcp.workers.mcp;
  assert.equal(generateConfigs(noMcp, bases).mcp, undefined);
  assert(!buildCommands(noMcp).some(step => step.args.includes('@gadgets/mcp-gatekeeper')));
});

test('admin model management is opt-in and changes no identities, scopes or bindings', () => {
  const legacy = structuredClone(example);
  delete legacy.modelBridge.management;
  const managed = structuredClone(legacy);
  managed.modelBridge.management = 'admin';
  const before = generateConfigs(legacy, bases);
  const after = generateConfigs(managed, bases);
  assert.equal(before.workshop.vars.CODEX_BRIDGE_MANAGEMENT, 'user');
  assert.equal(after.workshop.vars.CODEX_BRIDGE_MANAGEMENT, 'admin');
  assert.equal(buildCommands(legacy).find(step => step.env.VITE_CODEX_BRIDGE_MODEL)
    .env.VITE_CODEX_BRIDGE_MANAGEMENT, 'user');
  assert.equal(buildCommands(managed).find(step => step.env.VITE_CODEX_BRIDGE_MODEL)
    .env.VITE_CODEX_BRIDGE_MANAGEMENT, 'admin');
  after.workshop.vars.CODEX_BRIDGE_MANAGEMENT = 'user';
  assert.deepEqual(after, before);
  const explicitUser = structuredClone(legacy);
  explicitUser.modelBridge.management = 'user';
  assert.deepEqual(generateConfigs(explicitUser, bases), before);
});

test('cold builds produce typed-storage runtime exports before checking consumers', () => {
  const steps = buildCommands(example);
  const dependency = steps.findIndex(step => step.args.includes('@gadgets/typed-storage'));
  assert(dependency >= 0, 'typed-storage needs an explicit build, not just a TypeScript path alias');
  for (const consumer of ['@gadgets/gatekeeper-context', '@gadgets/workshop-backend']) {
    assert(dependency < steps.findIndex(step => step.args.includes(consumer)));
  }
});

test('site launch is opt-in and leaves existing storage, auth and connector policy unchanged', () => {
  const baseline = generateConfigs(example, bases);
  assert.equal(baseline.workshop.vars.SITE_LAUNCH_ISSUER, undefined);
  const enabled = structuredClone(example);
  enabled.siteLaunch = { parentOrigins: ['https://portal.example.com'] };
  const generated = generateConfigs(enabled, bases);
  assert.equal(generated.workshop.vars.SITE_LAUNCH_ISSUER, example.auth.issuer);
  assert.deepEqual(JSON.parse(generated.workshop.vars.SITE_LAUNCH_IDENTITIES), example.auth.allowedIdentities);
  assert.deepEqual(JSON.parse(generated.workshop.vars.SITE_LAUNCH_PARENT_ORIGINS), enabled.siteLaunch.parentOrigins);
  for (const key of ['SITE_LAUNCH_ISSUER', 'SITE_LAUNCH_IDENTITIES', 'SITE_LAUNCH_PARENT_ORIGINS']) {
    delete generated.workshop.vars[key];
  }
  assert.deepEqual(generated, baseline);
  const frontendEnv = buildCommands(enabled).find(step => step.env.VITE_CF_ACCESS_MODE).env;
  assert.deepEqual(JSON.parse(frontendEnv.VITE_SITE_LAUNCH_PARENT_ORIGINS), enabled.siteLaunch.parentOrigins);
  assert(!JSON.stringify(frontendEnv).includes(example.auth.allowedIdentities[0].subject));
  assert(!JSON.stringify(frontendEnv).includes(example.auth.allowedIdentities[0].email));
  assert.equal(buildCommands(example).find(step => step.env.VITE_CF_ACCESS_MODE).env.VITE_SITE_LAUNCH_PARENT_ORIGINS, '[]');
});

test('site launch accepts only a bounded unique list of canonical HTTPS parent origins', () => {
  for (const parentOrigins of [[], Array(11).fill('https://portal.example.com'),
    ['https://portal.example.com', 'https://portal.example.com'], ['http://portal.example.com'],
    ['https://portal.example.com/'], ['https://portal.example.com/site'], ['https://portal.example.com?x=1'],
    ['https://portal.example.com#fragment'], ['https://user:pass@portal.example.com'],
    ['https://portal.example.com:443'], ['https://portal.example.com:8443'],
    ['https://portal.example.workers.dev'], ['https://workers.dev'], ['https://PORTAL.example.com'], '*', null]) {
    assert.throws(() => parseDeployment({ ...example, siteLaunch: { parentOrigins } }));
  }
  assert.throws(() => parseDeployment({ ...example, siteLaunch: { parentOrigins: ['https://portal.example.com'], issuer: example.auth.issuer } }));
  assert.deepEqual(parseDeployment({ ...example, siteLaunch: { parentOrigins: ['https://portal.example.com', 'https://admin.example.com'] } }).siteLaunch.parentOrigins,
    ['https://portal.example.com', 'https://admin.example.com']);
});

test('connect links and OAuth callbacks stay on the router origin for every deployment', () => {
  const candidate = structuredClone(example);
  candidate.origin = 'https://pilot.example.net';
  const configs = generateConfigs(candidate, bases);
  assert.equal(configs.workshop.vars.PUBLIC_BASE_URL, candidate.origin);
  assert.equal(configs.oidc.vars.PUBLIC_BASE_URL, candidate.origin);
  assert.equal(configs.mcp.vars.BASE_URL, `${candidate.origin}/gatekeeper/mcp`);
  assert.equal(new URL(`${configs.mcp.vars.BASE_URL}/oauth`).href, `${candidate.origin}/gatekeeper/mcp/oauth`);
  assert(configs.router.services.some(binding => binding.binding === 'GATEKEEPER_MCP'
    && binding.service === configs.mcp.name));
  assert.equal(configs.mcp.vars.MCP_CLIENT_NAME, 'Cloud Agent OS');
  assert.equal(configs.workshop.services.find(binding => binding.binding === 'GATEKEEPER_CONTEXT')
    .props.sharingDomain, candidate.origin);
});

test('reject unsafe auth/deployment input before any build or deploy', () => {
  for (const mutate of [
    c => { c.auth.allowedIdentities = []; },
    c => { c.admins = ['stranger@example.com']; },
    c => { c.auth.allowedIdentities[0].subject = ''; },
    c => { c.auth.allowedIdentities[0].email = 'ADMIN@example.com'; },
    c => { c.modelBridge.allowedUserIds = ['stranger@example.com']; },
    c => { c.modelBridge.service = c.workers.workshop; },
    c => { c.modelBridge.management = 'Admin'; },
    c => { c.modelBridge.management = true; },
    c => { c.auth.clientSecret = 'must-never-be-in-config'; },
    c => { c.auth.issuer = 'http://auth.example.com'; },
    c => { c.auth.issuer = 'https://auth.example.com/oidc/'; },
    c => { c.auth.clientId = 'x'.repeat(256); },
    c => { c.auth.displayName = 'x'.repeat(129); },
    c => { c.auth.allowedIdentities[0].subject = 'x'.repeat(256); },
    c => { c.auth.loginUrl = 'https://auth.example.com/login'; c.auth.loginSite = 'invalid site'; },
    c => { c.origin = 'https://example.workers.dev'; },
    c => { c.origin = 'https://os.example.com/path'; },
    c => { c.workers.oidc = c.workers.router; },
    c => { delete c.workers.oidc; },
    c => { c.resources.contextKvNamespaceId = c.resources.avatarsKvNamespaceId; },
    c => { c.access = { enabled: true }; },
    c => { c.auth.loginSite = 'site-without-login-url'; },
    c => { c.mcpScopes = { 'https://mcp.example.com/team/mcp': ['read write'] }; },
  ]) {
    const candidate = structuredClone(example);
    mutate(candidate);
    assert.throws(() => parseDeployment(candidate));
  }
});

test('deployment cannot start without a private OIDC secret file', () => {
  const result = spawnSync(process.execPath, ['scripts/build.mjs', '--config', 'deployment.example.json', '--deploy'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--deploy requires --oidc-secrets/);
});
