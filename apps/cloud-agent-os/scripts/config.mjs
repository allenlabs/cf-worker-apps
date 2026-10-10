import assert from 'node:assert/strict';
import { configuredOAuthScope } from '../overlay/packages/mcp-shared/src/oauth-scope.ts';

export const packages = Object.freeze({
  context: 'packages/gatekeeper-context',
  oidc: 'packages/gatekeeper-oidc',
  mcp: 'packages/gatekeeper-mcp',
  workshop: 'packages/workshop-backend',
  router: 'packages/router',
});

function object(value, keys, name) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${name} must be an object`);
  assert(Object.keys(value).every(key => keys.includes(key)), `${name} contains an unsupported field`);
}

function text(value, name, pattern = /^[^\s\x00-\x1f\x7f][^\x00-\x1f\x7f]*$/) {
  assert(typeof value === 'string' && value === value.trim() && pattern.test(value), `Invalid ${name}`);
}

function https(value, name) {
  text(value, name);
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash,
    `${name} must be HTTPS without credentials, query or fragment`);
  return url;
}

function emails(value, name) {
  assert(Array.isArray(value) && value.length > 0, `${name} must not be empty`);
  for (const email of value) {
    text(email, name, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    assert(email.length <= 320, `${name} is too long`);
    assert(email === email.toLowerCase(), `${name} must use canonical lowercase email identities`);
  }
  assert(new Set(value).size === value.length, `${name} contains duplicates`);
}

/** Parse private deployment input before creating any files or running a build. */
export function parseDeployment(value) {
  object(value, ['accountId', 'origin', 'workers', 'resources', 'auth', 'admins', 'modelBridge', 'mcp', 'mcpScopes', 'siteLaunch'], 'deployment');
  text(value.accountId, 'accountId', /^[a-f0-9]{32}$/);
  const origin = https(value.origin, 'origin');
  assert(origin.origin === value.origin && !origin.port && !origin.hostname.endsWith('.workers.dev'),
    'origin must be a custom-domain origin without a path or port');
  object(value.workers, ['router', 'workshop', 'context', 'oidc', 'mcp'], 'workers');
  assert(typeof value.mcp === 'boolean', 'mcp must be a boolean');
  if (value.mcpScopes !== undefined) {
    assert(value.mcp, 'mcpScopes requires mcp=true');
    configuredOAuthScope(JSON.stringify(value.mcpScopes), 'https://validation.example.invalid/mcp');
  }
  const names = value.mcp ? Object.keys(packages) : Object.keys(packages).filter(key => key !== 'mcp');
  assert(value.mcp || value.workers.mcp === undefined, 'workers.mcp requires mcp=true');
  for (const key of names) text(value.workers[key], `workers.${key}`, /^[a-z][a-z0-9-]{0,62}$/);
  assert(new Set(names.map(key => value.workers[key])).size === names.length, 'Worker names must be unique');
  object(value.resources, ['blueprintsKvNamespaceId', 'avatarsKvNamespaceId', 'contextKvNamespaceId', 'blueprintContentBucket'], 'resources');
  for (const key of ['blueprintsKvNamespaceId', 'avatarsKvNamespaceId', 'contextKvNamespaceId']) {
    text(value.resources[key], `resources.${key}`, /^[a-f0-9]{32}$/);
  }
  assert(new Set(['blueprintsKvNamespaceId', 'avatarsKvNamespaceId', 'contextKvNamespaceId']
    .map(key => value.resources[key])).size === 3, 'KV namespaces must be separate');
  text(value.resources.blueprintContentBucket, 'blueprintContentBucket', /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/);
  object(value.auth, ['issuer', 'clientId', 'displayName', 'allowedIdentities', 'loginUrl', 'loginSite'], 'auth');
  const issuer = https(value.auth.issuer, 'auth.issuer');
  assert(issuer.href.replace(/\/$/, '') === value.auth.issuer, 'auth.issuer must be canonical without a trailing slash');
  text(value.auth.clientId, 'auth.clientId');
  text(value.auth.displayName, 'auth.displayName');
  assert(value.auth.clientId.length <= 255 && value.auth.displayName.length <= 128, 'OIDC client or display name is too long');
  assert(Array.isArray(value.auth.allowedIdentities) && value.auth.allowedIdentities.length > 0
    && value.auth.allowedIdentities.length <= 100, 'auth.allowedIdentities must pin 1–100 emails and subjects');
  for (const identity of value.auth.allowedIdentities) {
    object(identity, ['email', 'subject'], 'auth.allowedIdentities[]');
    text(identity.subject, 'auth.allowedIdentities[].subject');
    assert(identity.subject.length <= 255, 'OIDC subject is too long');
  }
  const allowed = value.auth.allowedIdentities.map(identity => identity.email);
  emails(allowed, 'auth.allowedIdentities[].email');
  assert(new Set(value.auth.allowedIdentities.map(identity => identity.subject)).size === allowed.length,
    'OIDC subjects must be unique');
  if (value.auth.loginUrl !== undefined) https(value.auth.loginUrl, 'auth.loginUrl');
  if (value.auth.loginSite !== undefined) {
    text(value.auth.loginSite, 'auth.loginSite', /^[A-Za-z0-9_-]{1,96}$/);
    assert(value.auth.loginUrl !== undefined, 'auth.loginSite requires auth.loginUrl');
  }
  emails(value.admins, 'admins');
  assert(value.admins.every(email => allowed.includes(email)), 'Every admin must be allowed to sign in');
  object(value.modelBridge, ['service', 'model', 'allowedUserIds', 'management'], 'modelBridge');
  assert(value.modelBridge.management === undefined || ['user', 'admin'].includes(value.modelBridge.management),
    'modelBridge.management must be user or admin');
  text(value.modelBridge.service, 'modelBridge.service', /^[a-z][a-z0-9-]{0,62}$/);
  assert(!names.some(key => value.workers[key] === value.modelBridge.service), 'Model service must be a separate runtime');
  text(value.modelBridge.model, 'modelBridge.model', /^[a-zA-Z0-9._/-]+$/);
  emails(value.modelBridge.allowedUserIds, 'modelBridge.allowedUserIds');
  assert(value.modelBridge.allowedUserIds.every(email => allowed.includes(email)),
    'Every model user must be allowed to sign in');
  if (value.siteLaunch !== undefined) {
    object(value.siteLaunch, ['parentOrigins'], 'siteLaunch');
    const parents = value.siteLaunch.parentOrigins;
    assert(Array.isArray(parents) && parents.length >= 1 && parents.length <= 10,
      'siteLaunch.parentOrigins must contain 1–10 origins');
    for (const parent of parents) {
      const url = https(parent, 'siteLaunch.parentOrigins[]');
      assert(url.origin === parent && !url.port && url.hostname !== 'workers.dev' && !url.hostname.endsWith('.workers.dev'),
        'siteLaunch parent must be a canonical custom-domain origin without a path or port');
    }
    assert(new Set(parents).size === parents.length, 'siteLaunch.parentOrigins contains duplicates');
  }
  return structuredClone(value);
}

/** Preserve upstream migrations/build rules; replace deployment-owned routes and bindings. */
export function generateConfigs(input, bases) {
  const config = parseDeployment(input);
  const keys = Object.keys(packages).filter(key => key !== 'mcp' || config.mcp);
  const result = {};
  for (const key of keys) {
    assert(bases[key] && typeof bases[key].main === 'string', `Missing upstream ${key} base config`);
    result[key] = {
      ...structuredClone(bases[key]),
      account_id: config.accountId,
      name: config.workers[key],
      workers_dev: false,
      preview_urls: false,
      routes: [],
      observability: { enabled: true, head_sampling_rate: 1, logs: { invocation_logs: false } },
    };
  }
  const vendors = ['context', 'oidc', ...(config.mcp ? ['mcp'] : [])];
  result.router.routes = [{ pattern: new URL(config.origin).hostname, custom_domain: true }];
  result.router.services = [
    { binding: 'WORKSHOP_BACKEND', service: config.workers.workshop },
    ...vendors.map(key => ({ binding: `GATEKEEPER_${key.toUpperCase()}`, service: config.workers[key] })),
  ];
  result.workshop.vars = {
    PUBLIC_BASE_URL: config.origin,
    ADMINS: config.admins,
    AUTH_GATEKEEPERS: 'oidc',
    DISABLE_PASSWORD_AUTH: 'true',
    CODEX_BRIDGE_MODEL: config.modelBridge.model,
    CODEX_BRIDGE_MANAGEMENT: config.modelBridge.management ?? 'user',
    CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify(config.modelBridge.allowedUserIds),
    ...(config.siteLaunch ? {
      SITE_LAUNCH_ISSUER: config.auth.issuer,
      SITE_LAUNCH_IDENTITIES: JSON.stringify(config.auth.allowedIdentities),
      SITE_LAUNCH_PARENT_ORIGINS: JSON.stringify(config.siteLaunch.parentOrigins),
    } : {}),
  };
  result.workshop.services = [
    ...vendors.map(key => ({
      binding: `GATEKEEPER_${key.toUpperCase()}`,
      service: config.workers[key],
      entrypoint: 'GatekeeperVendor',
      ...(key === 'context' ? { props: { sharingDomain: config.origin } } : {}),
    })),
    { binding: 'CODEX_BRIDGE', service: config.modelBridge.service, entrypoint: 'CloudAgentInference' },
  ];
  result.workshop.ai = { binding: 'WORKERS_AI' };
  result.workshop.kv_namespaces = [
    { binding: 'BLUEPRINTS', id: config.resources.blueprintsKvNamespaceId },
    { binding: 'AVATARS', id: config.resources.avatarsKvNamespaceId },
  ];
  result.workshop.r2_buckets = [{ binding: 'BLUEPRINT_CONTENT', bucket_name: config.resources.blueprintContentBucket }];
  delete result.workshop.assets;
  result.context.kv_namespaces = [{ binding: 'CONTEXT_COLLECTIONS', id: config.resources.contextKvNamespaceId }];
  delete result.context.artifacts;
  result.oidc.vars = {
    PUBLIC_BASE_URL: config.origin,
    OIDC_ISSUER: config.auth.issuer,
    OIDC_CLIENT_ID: config.auth.clientId,
    OIDC_DISPLAY_NAME: config.auth.displayName,
    OIDC_ALLOWED_IDENTITIES: JSON.stringify(config.auth.allowedIdentities),
    ...(config.auth.loginUrl ? { OIDC_LOGIN_URL: config.auth.loginUrl } : {}),
    ...(config.auth.loginSite ? { OIDC_LOGIN_SITE: config.auth.loginSite } : {}),
  };
  result.oidc.secrets = { required: ['OIDC_CLIENT_SECRET'] };
  if (result.mcp) result.mcp.vars = {
    BASE_URL: `${config.origin}/gatekeeper/mcp`,
    MCP_CLIENT_NAME: 'Cloud Agent OS',
    MCP_ALLOW_INSECURE: 'false',
    ...(config.mcpScopes ? { MCP_OAUTH_SCOPES: JSON.stringify(config.mcpScopes) } : {}),
  };
  return result;
}

export function buildCommands(config) {
  parseDeployment(config);
  const task = (pkg, name = 'build', env = {}) => ({
    args: ['exec', 'vp', 'run', '-F', pkg, '--no-cache', name], env,
  });
  return [
    task('@gadgets/typed-storage'),
    task('@gadgets/gatekeeper-context', 'build:app'),
    task('@gadgets/gatekeeper-context'),
    ...(config.mcp ? [task('@gadgets/mcp-shared'), task('@gadgets/mcp-gatekeeper', 'build:configurator')] : []),
    task('@gadgets/workshop-frontend', 'build', {
      VITE_CF_ACCESS_MODE: 'false', VITE_CODEX_BRIDGE_MODEL: config.modelBridge.model,
      VITE_CODEX_BRIDGE_MANAGEMENT: config.modelBridge.management ?? 'user',
      VITE_SITE_LAUNCH_PARENT_ORIGINS: JSON.stringify(config.siteLaunch?.parentOrigins ?? []),
    }),
    task('@gadgets/router'),
    task('@gadgets/workshop-backend'),
  ];
}
