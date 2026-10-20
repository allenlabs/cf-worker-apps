import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildCommands, deploymentOrder, generateConfigs, packages, parseDeployment, requiresOidcSecret } from '../scripts/config.mjs';

const example = JSON.parse(await readFile(new URL('../deployment.example.json', import.meta.url), 'utf8'));
const accessExample = JSON.parse(await readFile(new URL('../deployment.access.example.json', import.meta.url), 'utf8'));
const bases = Object.fromEntries(Object.keys(packages).map(key => [key, {
  main: 'src/index.ts', workers_dev: true, preview_urls: true,
  routes: [{ pattern: 'old.example.com' }],
  migrations: [{ tag: 'v0', new_sqlite_classes: ['ExistingObject'] }],
  vars: { CF_ACCESS_AUD: 'old', CF_ACCESS_ISS: 'https://old.example.com' },
  ...(key === 'router' ? { assets: {
    binding: 'ASSETS', directory: '../workshop-frontend/dist', run_worker_first: ['/gatekeeper/*'],
  } } : {}),
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

test('rejects provider-prefixed model IDs before generating deployment configuration', () => {
  const candidate = structuredClone(example);
  candidate.modelBridge.model = 'openai/gpt-6.1-sol';
  assert.throws(() => generateConfigs(candidate, bases), /modelBridge.model/);
});

test('rejects model IDs longer than the bridge permits', () => {
  const candidate = structuredClone(example);
  candidate.modelBridge.model = 'a'.repeat(129);
  assert.throws(() => parseDeployment(candidate), /modelBridge.model/);
});

test('accepts syntactic model IDs without freezing runtime catalog availability', () => {
  for (const model of ['unknown-model', 'Model_1.2-3', 'a'.repeat(128)]) {
    const candidate = structuredClone(example);
    candidate.modelBridge.model = model;
    assert.equal(parseDeployment(candidate).modelBridge.model, model);
    assert.equal(generateConfigs(candidate, bases).workshop.vars.CODEX_BRIDGE_MODEL, model);
  }
});

const modelUsers = count => Array.from({ length: count }, (_, index) => `model-${index}@example.invalid`);
const maxBridgeEmail = `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(53)}.invalid`;
function withModelUsers(users) {
  const candidate = structuredClone(example);
  candidate.auth.allowedIdentities.push(...users.map((email, index) => ({ email, subject: `model-subject-${index}` })));
  candidate.modelBridge.allowedUserIds = users;
  return candidate;
}

test('rejects more model users than the bridge permits', () => {
  assert.throws(() => generateConfigs(withModelUsers(modelUsers(21)), bases), /modelBridge.allowedUserIds/);
});

test('accepts the twenty-user bridge boundary', () => {
  const users = modelUsers(20);
  const configs = generateConfigs(withModelUsers(users), bases);
  assert.deepEqual(JSON.parse(configs.workshop.vars.CODEX_BRIDGE_ALLOWED_USER_IDS), users);
});

test('rejects model email identities longer than the bridge permits', () => {
  const email = maxBridgeEmail.replace('.invalid', 'd.invalid');
  assert.equal(email.length, 255);
  assert.throws(() => parseDeployment(withModelUsers([email])), /modelBridge.allowedUserIds/);
});

test('accepts a 254-character model email identity', () => {
  assert.equal(maxBridgeEmail.length, 254);
  assert.deepEqual(parseDeployment(withModelUsers([maxBridgeEmail])).modelBridge.allowedUserIds, [maxBridgeEmail]);
});

test('keeps the wider login and administrator identity bounds', () => {
  const candidate = structuredClone(example);
  const longEmail = `${'a'.repeat(304)}@example.invalid`;
  assert.equal(longEmail.length, 320);
  const emails = [example.modelBridge.allowedUserIds[0], ...modelUsers(98), longEmail];
  candidate.auth.allowedIdentities = emails.map((email, index) => ({ email, subject: `login-subject-${index}` }));
  candidate.admins = emails;
  candidate.modelBridge.allowedUserIds = [emails[0]];
  const parsed = parseDeployment(candidate);
  assert.equal(parsed.auth.allowedIdentities.length, 100);
  assert.deepEqual(parsed.admins, emails);
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


test('explicit OIDC mode preserves legacy generated configuration and build commands', () => {
  const explicit = structuredClone(example);
  explicit.auth.mode = 'oidc';
  assert.deepEqual(generateConfigs(explicit, bases), generateConfigs(example, bases));
  assert.deepEqual(buildCommands(explicit), buildCommands(example));
  assert.deepEqual(deploymentOrder(explicit), ['context', 'oidc', 'mcp', 'workshop', 'router']);
});

test('OAuth JWT is explicit, pins its resource and scopes, and only post requires a secret', () => {
  const input = structuredClone(example);
  Object.assign(input.auth, { mode: 'oauth-jwt', resource: 'https://resource.example.com',
    scopes: ['profile', 'email', 'offline_access'], tokenEndpointAuthMethod: 'none' });
  const generated = generateConfigs(input, bases);
  assert.equal(generated.oidc.vars.SIGN_IN_PROTOCOL, 'oauth-jwt');
  assert.equal(generated.oidc.vars.OAUTH_JWT_RESOURCE, input.auth.resource);
  assert.deepEqual(JSON.parse(generated.oidc.vars.OAUTH_JWT_SCOPES), input.auth.scopes);
  assert.equal(generated.oidc.vars.OAUTH_JWT_TOKEN_ENDPOINT_AUTH_METHOD, 'none');
  assert.equal(generated.oidc.secrets, undefined);
  assert.equal(requiresOidcSecret(input), false);
  assert.equal(generated.workshop.vars.AUTH_GATEKEEPERS, 'oidc');
  const post = structuredClone(input);
  post.auth.tokenEndpointAuthMethod = 'client_secret_post';
  assert.equal(requiresOidcSecret(post), true);
  assert.deepEqual(generateConfigs(post, bases).oidc.secrets.required, ['OIDC_CLIENT_SECRET']);
  for (const mutate of [
    c => { delete c.auth.mode; },
    c => { delete c.auth.tokenEndpointAuthMethod; },
    c => { c.auth.tokenEndpointAuthMethod = 'client_secret_basic'; },
    c => { c.auth.resource += '/path'; },
    c => { c.auth.resource += '/'; },
    c => { c.auth.resource = 'http://resource.example.com'; },
    c => { c.auth.scopes = []; },
    c => { c.auth.scopes = ['read write']; },
    c => { c.auth.scopes = ['profile', 'profile']; },
    c => { c.auth.scopes = ['openid']; },
    c => { c.auth.clientSecret = 'not-configuration'; },
  ]) {
    const bad = structuredClone(input); mutate(bad);
    assert.throws(() => parseDeployment(bad));
  }
});

test('Access uses native authentication without an OIDC worker, binding or secret', () => {
  const accessBases = structuredClone(bases);
  delete accessBases.oidc;
  const configs = generateConfigs(accessExample, accessBases);
  assert.deepEqual(Object.keys(configs), ['context', 'mcp', 'workshop', 'router']);
  assert.deepEqual(deploymentOrder(accessExample), Object.keys(configs));
  assert.equal(configs.workshop.vars.CF_ACCESS_AUD, accessExample.auth.audience);
  assert.equal(configs.workshop.vars.CF_ACCESS_ISS, accessExample.auth.issuer);
  assert.equal(configs.workshop.vars.AUTH_GATEKEEPERS, undefined);
  assert.equal(configs.workshop.vars.DISABLE_PASSWORD_AUTH, 'true');
  assert.equal(configs.workshop.vars.SITE_LAUNCH_ISSUER, undefined);
  assert.deepEqual(configs.workshop.vars.ADMINS, accessExample.admins);
  assert.deepEqual(JSON.parse(configs.workshop.vars.CODEX_BRIDGE_ALLOWED_USER_IDS), accessExample.modelBridge.allowedUserIds);
  for (const config of Object.values(configs)) {
    assert.equal(config.workers_dev, false);
    assert.equal(config.preview_urls, false);
    assert(!config.services?.some(binding => binding.binding === 'GATEKEEPER_OIDC'));
    assert(!config.secrets?.required?.includes('OIDC_CLIENT_SECRET'));
  }
  const frontend = buildCommands(accessExample).find(step => step.env.VITE_CF_ACCESS_MODE).env;
  assert.equal(frontend.VITE_CF_ACCESS_MODE, 'true');
  assert.equal(frontend.VITE_SITE_LAUNCH_PARENT_ORIGINS, '[]');
  assert(!JSON.stringify(frontend).includes(accessExample.auth.allowedEmails[0]));
  assert(!buildCommands(accessExample).some(step => step.args.some(arg => arg.includes('oidc'))));
  const noMcp = structuredClone(accessExample);
  noMcp.mcp = false;
  delete noMcp.workers.mcp;
  assert.deepEqual(deploymentOrder(noMcp), ['context', 'workshop', 'router']);
  assert.deepEqual(Object.keys(generateConfigs(noMcp, accessBases)), deploymentOrder(noMcp));
});

test('OAuth JWT provider service is explicit and bound only to the private sign-in Worker', () => {
  const input = structuredClone(example);
  Object.assign(input.auth, { mode: 'oauth-jwt', resource: 'https://resource.example.com',
    scopes: ['profile', 'email'], tokenEndpointAuthMethod: 'none' });
  const before = generateConfigs(input, bases);
  assert.equal(before.oidc.services, undefined);
  const stale = structuredClone(bases);
  stale.oidc.services = [{ binding: 'IDENTITY_PROVIDER', service: 'stale-provider' }];
  assert.equal(generateConfigs(input, stale).oidc.services, undefined, 'a base config cannot silently enable a provider binding');
  input.auth.providerService = 'example-identity-provider';
  const after = generateConfigs(input, bases);
  assert.deepEqual(after.oidc.services, [{ binding: 'IDENTITY_PROVIDER', service: input.auth.providerService }]);
  assert.equal(after.oidc.workers_dev, false);
  assert.deepEqual(after.oidc.routes, []);
  delete after.oidc.services;
  assert.deepEqual(after, before, 'provider routing does not change browser URLs, identities or other Workers');
  for (const providerService of ['', null, 42, {}, 'https://identity.example.com', 'UPPER', 'a'.repeat(64), input.workers.oidc]) {
    const bad = structuredClone(input);
    bad.auth.providerService = providerService;
    assert.throws(() => parseDeployment(bad), /providerService|separate Worker/);
  }
  for (const mode of [undefined, 'oidc', 'access']) {
    const bad = structuredClone(mode === 'access' ? accessExample : example);
    bad.auth.mode = mode;
    bad.auth.providerService = 'example-identity-provider';
    assert.throws(() => parseDeployment(bad), /unsupported field/);
  }
});

test('Access requires bounded explicit email policy, issuer and audience, and rejects OIDC-only features', () => {
  for (const mutate of [
    c => { c.auth.mode = 'unknown'; },
    c => { delete c.auth.mode; },
    c => { delete c.auth.audience; },
    c => { c.auth.audience = ''; },
    c => { c.auth.audience = 'with whitespace'; },
    c => { c.auth.audience = 'a'.repeat(256); },
    c => { c.auth.issuer = 'http://example.cloudflareaccess.com'; },
    c => { c.auth.issuer = 'https://auth.example.com'; },
    c => { c.auth.issuer = 'https://example.cloudflareaccess.com/path'; },
    c => { c.auth.issuer = 'https://example.cloudflareaccess.com:443'; },
    c => { c.auth.issuer = 'https://example.cloudflareaccess.com:8443'; },
    c => { c.auth.issuer = 'https://example.cloudflareaccess.com/'; },
    c => { c.auth.issuer = 'https://example.cloudflareaccess.com?query=1'; },
    c => { c.auth.issuer = 'https://user:pass@example.cloudflareaccess.com'; },
    c => { delete c.auth.allowedEmails; },
    c => { c.auth.allowedEmails = []; },
    c => { c.auth.allowedEmails = modelUsers(101); },
    c => { c.auth.allowedEmails.push(c.auth.allowedEmails[0]); },
    c => { c.auth.allowedEmails[0] = 'ADMIN@example.com'; },
    c => { c.admins = ['stranger@example.com']; },
    c => { c.modelBridge.allowedUserIds = ['stranger@example.com']; },
    c => { delete c.modelBridge; },
    c => { c.auth.clientId = 'oidc-client'; },
    c => { c.auth.allowedIdentities = example.auth.allowedIdentities; },
    c => { c.auth.loginUrl = 'https://auth.example.com/login'; },
    c => { c.workers.oidc = 'example-os-oidc'; },
    c => { c.siteLaunch = { parentOrigins: ['https://portal.example.com'] }; },
  ]) {
    const candidate = structuredClone(accessExample);
    mutate(candidate);
    assert.throws(() => parseDeployment(candidate));
  }
  const bounded = structuredClone(accessExample);
  bounded.auth.allowedEmails = [accessExample.admins[0], ...modelUsers(99)];
  assert.equal(parseDeployment(bounded).auth.allowedEmails.length, 100);
});

test('omitting SIWC setup preserves the existing model bridge and router services', () => {
  for (const candidate of [example, accessExample]) {
    assert.deepEqual(parseDeployment(candidate), candidate);
    const configs = generateConfigs(candidate, bases);
    assert(!configs.router.services.some(binding => binding.binding === 'GATEKEEPER_SUBSCRIPTION'));
    assert.equal(configs.workshop.vars.CODEX_BRIDGE_SETUP, undefined);
    assert.deepEqual(configs.workshop.services.find(binding => binding.binding === 'CODEX_BRIDGE'), {
      binding: 'CODEX_BRIDGE', service: candidate.modelBridge.service, entrypoint: 'CloudAgentInference',
    });
  }
});

test('SIWC setup adds its router binding and server-owned capability while preserving worker permissions', () => {
  for (const mcp of [true, false]) {
    const baseline = structuredClone(accessExample);
    baseline.mcp = mcp;
    if (!mcp) delete baseline.workers.mcp;
    const enabled = structuredClone(baseline);
    enabled.modelBridge.setup = 'siwc';
    const configs = generateConfigs(enabled, bases);
    assert.deepEqual(configs.router.services.at(-1), {
      binding: 'GATEKEEPER_SUBSCRIPTION', service: enabled.modelBridge.service,
    });
    assert(!configs.workshop.services.some(binding => binding.binding === 'GATEKEEPER_SUBSCRIPTION'));
    assert.deepEqual(configs.router.assets.run_worker_first, ['/gatekeeper/*']);
    for (const config of Object.values(configs)) {
      assert.equal(config.workers_dev, false);
      assert.equal(config.preview_urls, false);
      assert(!config.services?.some(binding => binding.binding === 'GATEKEEPER_OIDC'));
      assert(!config.secrets?.required?.includes('OIDC_CLIENT_SECRET'));
    }
    assert.equal(configs.workshop.vars.CODEX_BRIDGE_SETUP, 'siwc');
    delete configs.workshop.vars.CODEX_BRIDGE_SETUP;
    configs.router.services.pop();
    assert.equal(JSON.stringify(configs), JSON.stringify(generateConfigs(baseline, bases)));
    assert.deepEqual(buildCommands(enabled), buildCommands(baseline));
    assert.deepEqual(deploymentOrder(enabled), deploymentOrder(baseline));
  }
});

test('SIWC setup rejects every other setup value and supports OIDC authentication', () => {
  for (const setup of ['', 'SIWC', 'codex', 'device', 'api', null, true, {}, []]) {
    const candidate = structuredClone(accessExample);
    candidate.modelBridge.setup = setup;
    assert.throws(() => parseDeployment(candidate), /modelBridge.setup must be siwc/);
  }
  for (const mode of [undefined, 'oidc']) {
    const candidate = structuredClone(example);
    candidate.auth.mode = mode;
    candidate.modelBridge.setup = 'siwc';
    const configs = generateConfigs(candidate, bases);
    assert.deepEqual(configs.router.services.at(-1), { binding: 'GATEKEEPER_SUBSCRIPTION', service: candidate.modelBridge.service });
    delete candidate.modelBridge.setup;
    assert.equal(configs.workshop.vars.CODEX_BRIDGE_SETUP, 'siwc');
    delete configs.workshop.vars.CODEX_BRIDGE_SETUP;
    configs.router.services.pop();
    assert.deepEqual(configs, generateConfigs(candidate, bases));
  }
  const shared = structuredClone(accessExample);
  shared.modelBridge.setup = 'siwc';
  shared.modelBridge.service = shared.workers.workshop;
  assert.throws(() => parseDeployment(shared), /Model service must be a separate runtime/);
});

test('Access CLI plans omit OIDC and reject irrelevant OIDC secret exports', () => {
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const plan = spawnSync(process.execPath, ['scripts/build.mjs', '--config', 'deployment.access.example.json', '--plan'], {
    cwd, encoding: 'utf8',
  });
  assert.equal(plan.status, 0, plan.stderr);
  assert.deepEqual(JSON.parse(plan.stdout).order, ['context', 'mcp', 'workshop', 'router']);
  const rejected = spawnSync(process.execPath, ['scripts/build.mjs', '--config', 'deployment.access.example.json',
    '--deploy', '--oidc-secrets', 'not-a-secret-file'], { cwd, encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /--oidc-secrets requires OIDC authentication/);
});

test('Access and public OAuth JWT checks and deployments need no OIDC secret file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-agent-os-access-'));
  try {
    // Replace only external commands and upstream preparation. The real build script still parses
    // configuration, generates Wrangler files, selects checks and constructs deployment commands.
    await mkdir(join(dir, 'scripts'));
    const parser = join(dir, 'node_modules/jsonc-parser');
    await mkdir(parser, { recursive: true });
    await writeFile(join(parser, 'index.js'), 'exports.parse = JSON.parse;');
    for (const [key, pkg] of Object.entries(packages)) {
      await mkdir(join(dir, pkg), { recursive: true });
      await writeFile(join(dir, pkg, 'wrangler.jsonc'), JSON.stringify(bases[key]));
    }
    const loader = join(dir, 'loader.mjs');
    const replacement = `export const wrapperRoot = ${JSON.stringify(dir)};
      export async function prepare() { return ${JSON.stringify(dir)}; }
      export function run(command, args, options) { console.log(JSON.stringify({command, args, cwd: options.cwd})); }`;
    await writeFile(loader, `import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, nextResolve) {
        if (specifier === './prepare.mjs' && context.parentURL.endsWith('/scripts/build.mjs')) {
          return { url: ${JSON.stringify('data:text/javascript,' + encodeURIComponent(replacement))}, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }});`);
    for (const [configFile, deployment] of [['deployment.access.example.json', accessExample],
      ['deployment.oauth-jwt.example.json', JSON.parse(await readFile(new URL('../deployment.oauth-jwt.example.json', import.meta.url), 'utf8'))]]) {
    for (const mode of ['--check', '--deploy']) {
      const result = spawnSync(process.execPath, ['--import', loader, 'scripts/build.mjs', '--config',
        configFile, mode], {
        cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8',
      });
      assert.equal(result.status, 0, result.stderr);
      const commands = result.stdout.trim().split('\n').map(line => JSON.parse(line));
      const access = deployment.auth.mode === 'access';
      assert.equal(commands.some(command => command.cwd.endsWith('gatekeeper-oidc')), !access);
      const deployments = commands.filter(command => command.args.includes('wrangler'));
      assert.deepEqual(deployments.map(command => command.cwd), deploymentOrder(deployment).map(key => join(dir, packages[key])));
      assert(deployments.every(command => !command.args.includes('--secrets-file')));
      assert(deployments.every(command => command.args.includes('--dry-run') === (mode === '--check')));
      if (mode === '--check') {
        assert.equal(commands.some(command => command.args.includes('__tests__/access.test.ts')), access);
        for (const file of ['src/useAuth.test.tsx', 'src/redirectLogin.test.tsx',
          'src/ConnectHandoffPage.test.tsx', 'src/components/auth/OAuthButtons.test.tsx', '__tests__/redirect-login.test.ts',
          'src/features/chat/composer/ComposerModelSelector.test.tsx',
          'src/features/chat/composer/ChatComposer.test.tsx', 'src/homePromptFlow.test.tsx']) {
          assert(commands.some(command => command.args.includes(file)), `Missing native UI check: ${file}`);
        }
        if (!access) {
          assert(commands.some(command => command.args.includes('oauth-jwt')));
          assert(commands.some(command => command.args.includes('oauth-jwt-service')));
          assert.equal(commands.filter(command => command.args.some(arg => arg.endsWith('/gatekeeper-oidc/tests/check.mjs'))).length, 3);
        }
      }
    }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
