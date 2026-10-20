import { z } from 'zod';
import { AGENT_PERMISSIONS, type AgentDelegation, type AgentPermission, type AgentResource, type AgentScope, type AgentSettingsCommand, type AgentSettingsView, type AgentTeam } from '@gadgets/workshop-shared/agent-settings';
import { validateWebFetchUrl } from './web-fetch.js';

export type AgentActor = { userId: string; organizationAdmin: boolean };
export class AgentSettingsError extends Error {
  constructor(message: string, readonly status = 400) { super(message); this.name = 'AgentSettingsError'; }
}

const POLICY_KEY = 'agent-settings.policy.v1';
const SECRETS_KEY = 'agent-settings.secrets.v1';
const MAX_RECORD_BYTES = 120_000;
const id = z.string().min(1).max(128).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const userId = z.string().min(1).max(320).refine(value => !/[\s\x00-\x1f\x7f-\x9f]/u.test(value));
const name = z.string().trim().min(1).max(120).refine(value => !/[\x00-\x1f\x7f-\x9f]/u.test(value));
const permissions = z.array(z.enum(AGENT_PERMISSIONS)).max(AGENT_PERMISSIONS.length).refine(values => new Set(values).size === values.length);
const scope = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('organization') }).strict(),
  z.object({ kind: z.literal('team'), teamId: id }).strict(),
  z.object({ kind: z.literal('personal'), userId }).strict(),
]);
const team = z.object({ id, name, parentId: id.nullable() }).strict();
const membership = z.object({ teamId: id, userId, role: z.enum(['admin', 'member']) }).strict();
const role = z.object({ id: id.refine(value => value !== 'admin' && value !== 'member'), name, scope, members: z.array(userId).max(2000).refine(values => new Set(values).size === values.length), permissions }).strict();
const delegation = z.object({ id, scope, subject: z.discriminatedUnion('kind', [z.object({ kind: z.literal('user'), id: userId }).strict(), z.object({ kind: z.literal('role'), id }).strict()]), permissions }).strict();
export function validateAgentEndpoint(value: string): boolean {
  if (/[\x00-\x20\x7f?#]/u.test(value)) return false;
  try {
    const url = validateWebFetchUrl(value);
    const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    // DNS resolution remains subject to the deployed workerd network routing policy.
    return !url.hash && !url.search && (url.port === '' || url.port === '443') && hostname.includes('.') && !hostname.startsWith('[') && !/^\d+(?:\.\d+)*$/.test(hostname) && !/(?:^|\.)(?:localhost|local|internal|home|lan|invalid|test)$/.test(hostname);
  } catch { return false; }
}
const endpoint = z.string().min(1).max(2048).refine(validateAgentEndpoint, 'Use a public HTTPS endpoint without credentials, query, or fragment.');
const base = { id, name, scope, enabled: z.boolean() };
const resource = z.union([
  z.object({ ...base, kind: z.literal('skill'), description: z.string().max(1000), content: z.string().min(1).max(16_384) }).strict(),
  z.object({ ...base, kind: z.literal('mcp'), endpoint, description: z.string().max(1000) }).strict(),
  z.object({ ...base, kind: z.literal('plugin'), pluginId: z.literal('instructions'), instructions: z.string().min(1).max(16_384) }).strict(),
  z.object({ ...base, kind: z.literal('plugin'), pluginId: z.literal('tool-policy'), deniedTools: z.array(z.string().min(1).max(200)).max(100) }).strict(),
  z.object({ ...base, kind: z.literal('provider'), baseUrl: endpoint }).strict(),
]);
const grant = z.object({ id, providerId: id, scope, enabled: z.boolean() }).strict();
const actorSchema = z.object({ userId, organizationAdmin: z.boolean() }).strict();
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const commandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setMode'), expectedRevision: revision, easyMode: z.boolean() }).strict(),
  z.object({ type: z.literal('saveTeam'), expectedRevision: revision, team }).strict(),
  z.object({ type: z.literal('saveMembership'), expectedRevision: revision, membership }).strict(),
  z.object({ type: z.literal('removeMembership'), expectedRevision: revision, teamId: id, userId }).strict(),
  z.object({ type: z.literal('saveRole'), expectedRevision: revision, role }).strict(),
  z.object({ type: z.literal('removeRole'), expectedRevision: revision, roleId: id }).strict(),
  z.object({ type: z.literal('saveDelegation'), expectedRevision: revision, delegation }).strict(),
  z.object({ type: z.literal('removeDelegation'), expectedRevision: revision, delegationId: id }).strict(),
  z.object({ type: z.literal('saveResource'), expectedRevision: revision, resource, apiToken: z.string().max(4096).refine(value => !/[\x00-\x20\x7f]/u.test(value)).optional() }).strict(),
  z.object({ type: z.literal('removeResource'), expectedRevision: revision, resourceId: id }).strict(),
  z.object({ type: z.literal('saveProviderGrant'), expectedRevision: revision, grant }).strict(),
  z.object({ type: z.literal('removeProviderGrant'), expectedRevision: revision, grantId: id }).strict(),
]);
const policySchema = z.object({ revision, easyMode: z.boolean(), teams: z.array(team).max(200), memberships: z.array(membership).max(2000), roles: z.array(role).max(500), delegations: z.array(delegation).max(1000), resources: z.array(resource).max(500), providerGrants: z.array(grant).max(1000) }).strict();
type Policy = z.infer<typeof policySchema>;
const secretSchema = z.record(id, z.string().max(4096).refine(value => !/[\x00-\x20\x7f]/u.test(value)));
type Secrets = z.infer<typeof secretSchema>;
const empty = (): Policy => ({ revision: 0, easyMode: true, teams: [], memberships: [], roles: [], delegations: [], resources: [], providerGrants: [] });
const organization: AgentScope = { kind: 'organization' };
function scopeKey(value: AgentScope): string {
  switch (value.kind) {
    case 'organization': return 'organization';
    case 'team': return `team:${value.teamId}`;
    case 'personal': return `personal:${value.userId}`;
  }
}
function sameScope(a: AgentScope, b: AgentScope) { return scopeKey(a) === scopeKey(b); }
function fail(message: string, status = 400): never { throw new AgentSettingsError(message, status); }
function bounded(value: unknown) {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_RECORD_BYTES) fail('Agent settings exceed the storage limit.');
}
function parsed<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (!result.success) fail(message);
  return result.data;
}
function unique(values: string[]) { return new Set(values).size === values.length; }
export function validateAgentTeamGraph(teams: AgentTeam[]): void {
  const byId = new Map(teams.map(value => [value.id, value]));
  if (byId.size !== teams.length) fail('Duplicate team ID.');
  for (const value of teams) {
    const visited = new Set<string>([value.id]);
    let parentId = value.parentId;
    while (parentId !== null) {
      if (visited.has(parentId)) fail('Team hierarchy contains a cycle.');
      visited.add(parentId);
      const parent = byId.get(parentId);
      if (!parent) fail('Team parent does not exist.');
      parentId = parent.parentId;
    }
  }
}
function validScope(policy: Policy, value: AgentScope) {
  if (value.kind === 'team' && !policy.teams.some(item => item.id === value.teamId)) fail('Team does not exist.');
}
function validatePolicy(input: unknown): Policy {
  bounded(input);
  const policy = parsed(policySchema, input, 'Stored agent settings are invalid.');
  validateAgentTeamGraph(policy.teams);
  for (const entries of [policy.roles, policy.delegations, policy.resources, policy.providerGrants]) {
    if (!unique(entries.map(value => value.id))) fail('Duplicate settings ID.');
  }
  if (!unique(policy.memberships.map(value => `${value.teamId}\0${value.userId}`))) fail('Duplicate team membership.');
  for (const value of policy.memberships) validScope(policy, { kind: 'team', teamId: value.teamId });
  for (const value of [...policy.roles, ...policy.delegations, ...policy.resources, ...policy.providerGrants]) validScope(policy, value.scope);
  for (const value of policy.delegations) {
    if (value.subject.kind === 'role' && value.subject.id !== 'admin' && value.subject.id !== 'member') {
      const subjectRole = policy.roles.find(item => item.id === value.subject.id);
      if (!subjectRole || !sameScope(subjectRole.scope, value.scope)) fail('Delegated role must exist in the same scope.');
    }
  }
  for (const value of policy.providerGrants) {
    if (!policy.resources.some(item => item.id === value.providerId && item.kind === 'provider')) fail('Granted provider does not exist.');
  }
  return policy;
}
function validateSecrets(input: unknown, policy: Policy): Secrets {
  bounded(input);
  const secrets = parsed(secretSchema, input, 'Stored provider credentials are invalid.');
  if (Object.keys(secrets).length > 500 || Object.keys(secrets).some(key => !policy.resources.some(value => value.id === key && value.kind === 'provider'))) fail('Stored provider credentials are invalid.');
  return secrets;
}
function roleMember(policy: Policy, actor: AgentActor, delegation: AgentDelegation): boolean {
  if (delegation.subject.kind === 'user') return delegation.subject.id === actor.userId;
  const subjectId = delegation.subject.id;
  if (subjectId !== 'admin' && subjectId !== 'member') return policy.roles.some(value => value.id === subjectId && sameScope(value.scope, delegation.scope) && value.members.includes(actor.userId));
  switch (delegation.scope.kind) {
    case 'organization': return subjectId === 'member' || actor.organizationAdmin;
    case 'personal': return delegation.scope.userId === actor.userId;
    case 'team': {
      const teamId = delegation.scope.teamId;
      return policy.memberships.some(value => value.teamId === teamId && value.userId === actor.userId && (subjectId === 'member' || value.role === 'admin'));
    }
  }
}
function authorization(policy: Policy, actor: AgentActor) {
  const byId = new Map(policy.teams.map(value => [value.id, value]));
  const lineages = new Map<string, string[]>();
  for (const team of policy.teams) {
    const lineage: string[] = [];
    let current: AgentTeam | undefined = team;
    while (current) { lineage.push(current.id); current = current.parentId === null ? undefined : byId.get(current.parentId); }
    lineages.set(team.id, lineage);
  }
  const memberships = policy.memberships.filter(value => value.userId === actor.userId);
  const memberTeams = new Set(memberships.flatMap(value => lineages.get(value.teamId) ?? []));
  const explicit = new Map<string, AgentPermission[]>();
  const scopedPermissions = (value: AgentScope): AgentPermission[] => {
    const key = scopeKey(value);
    const previous = explicit.get(key);
    if (previous) return previous;
    const result = AGENT_PERMISSIONS.filter(permission => policy.roles.some(item => sameScope(item.scope, value) && item.members.includes(actor.userId) && item.permissions.includes(permission)) || policy.delegations.some(item => sameScope(item.scope, value) && item.permissions.includes(permission) && roleMember(policy, actor, item)));
    explicit.set(key, result);
    return result;
  };
  const organizationAdmin = actor.organizationAdmin || scopedPermissions(organization).length === AGENT_PERMISSIONS.length;
  const adminTeams = new Set([...memberships.filter(value => value.role === 'admin').map(value => value.teamId), ...policy.teams.filter(value => scopedPermissions({ kind: 'team', teamId: value.id }).length === AGENT_PERMISSIONS.length).map(value => value.id)]);
  const cached = new Map<string, AgentPermission[]>();
  const audience = (value: AgentScope) => value.kind === 'organization' || (value.kind === 'personal' ? value.userId === actor.userId : memberTeams.has(value.teamId));
  const permissions = (value: AgentScope): AgentPermission[] => {
    const key = scopeKey(value);
    const previous = cached.get(key);
    if (previous) return previous;
    const inheritedAdmin = value.kind === 'team' && (lineages.get(value.teamId) ?? []).some(id => adminTeams.has(id));
    const all = (value.kind !== 'personal' && organizationAdmin) || (value.kind === 'personal' && value.userId === actor.userId) || inheritedAdmin;
    const result = all ? [...AGENT_PERMISSIONS] : scopedPermissions(value);
    cached.set(key, result);
    return result;
  };
  return { audience, permissions };
}
type Authorization = ReturnType<typeof authorization>;
function requirePermissions(policy: Policy, access: Authorization, value: AgentScope, required: AgentPermission[]) {
  validScope(policy, value);
  const available = access.permissions(value);
  if (required.some(permission => !available.includes(permission))) fail('Permission denied for this scope.', 403);
}
function permissionFor(value: AgentResource): AgentPermission {
  switch (value.kind) {
    case 'provider': return 'providers:manage';
    case 'skill': return 'skills:manage';
    case 'mcp': return 'mcp:manage';
    case 'plugin': return 'plugins:manage';
  }
}
function immutableScope(previous: { scope: AgentScope } | undefined, next: { scope: AgentScope }) {
  if (previous && !sameScope(previous.scope, next.scope)) fail('An existing ID cannot move to another scope.');
}
function upsert<T extends { id: string }>(values: T[], value: T): T[] { return [...values.filter(item => item.id !== value.id), value]; }
function effective(policy: Policy, actor: AgentActor): AgentResource[] {
  const access = authorization(policy, actor);
  return policy.resources.filter(value => value.enabled && (access.audience(value.scope) || (value.kind === 'provider' && policy.providerGrants.some(item => item.enabled && item.providerId === value.id && access.audience(item.scope)))));
}
function view(policy: Policy, actor: AgentActor): AgentSettingsView {
  const access = authorization(policy, actor);
  const effectiveResources = effective(policy, actor);
  const effectiveIds = new Set(effectiveResources.map(value => value.id));
  const possibleScopes: AgentScope[] = [organization, { kind: 'personal', userId: actor.userId }, ...policy.teams.map(value => ({ kind: 'team' as const, teamId: value.id })), ...policy.roles.map(value => value.scope), ...policy.delegations.map(value => value.scope), ...policy.resources.map(value => value.scope)];
  const scopes = [...new Map(possibleScopes.map(value => [scopeKey(value), value])).values()].filter(value => access.audience(value) || access.permissions(value).length > 0).map(value => ({ scope: value, label: value.kind === 'organization' ? 'Organization' : value.kind === 'personal' ? value.userId : policy.teams.find(team => team.id === value.teamId)?.name ?? value.teamId, permissions: access.permissions(value) }));
  const visibleTeams = new Set(scopes.flatMap(value => value.scope.kind === 'team' ? [value.scope.teamId] : []));
  const can = (value: AgentScope, permission: AgentPermission) => access.permissions(value).includes(permission);
  const visibleResourceIds = new Set(policy.resources.filter(value => effectiveIds.has(value.id) || can(value.scope, permissionFor(value)) || (value.kind === 'provider' && (can(value.scope, 'providers:grant') || policy.providerGrants.some(grant => grant.providerId === value.id && can(grant.scope, 'providers:grant'))))).map(value => value.id));
  return {
    revision: policy.revision, easyMode: policy.easyMode, viewerId: actor.userId, scopes,
    teams: policy.teams.filter(value => visibleTeams.has(value.id)),
    memberships: policy.memberships.filter(value => value.userId === actor.userId || can({ kind: 'team', teamId: value.teamId }, 'members:manage')),
    roles: policy.roles.filter(value => value.members.includes(actor.userId) || can(value.scope, 'roles:manage')),
    delegations: policy.delegations.filter(value => roleMember(policy, actor, value) || can(value.scope, 'roles:manage')),
    resources: policy.resources.filter(value => visibleResourceIds.has(value.id)), effectiveResources,
    providerGrants: policy.providerGrants.filter(value => (access.audience(value.scope) && visibleResourceIds.has(value.providerId)) || can(value.scope, 'providers:grant')),
  };
}
function change(policy: Policy, secrets: Secrets, actor: AgentActor, command: AgentSettingsCommand): void {
  const access = authorization(policy, actor);
  if (command.expectedRevision !== policy.revision) fail('Agent settings changed. Reload before saving.', 409);
  switch (command.type) {
    case 'setMode':
      requirePermissions(policy, access, organization, ['settings:manage']); policy.easyMode = command.easyMode; break;
    case 'saveTeam': {
      const previous = policy.teams.find(value => value.id === command.team.id);
      if (previous && previous.parentId !== command.team.parentId) fail('An existing team cannot change parents.');
      const target: AgentScope = previous ? { kind: 'team', teamId: previous.id } : command.team.parentId === null ? organization : { kind: 'team', teamId: command.team.parentId };
      requirePermissions(policy, access, target, ['teams:manage']); policy.teams = upsert(policy.teams, command.team); break;
    }
    case 'saveMembership': {
      const target: AgentScope = { kind: 'team', teamId: command.membership.teamId };
      const memberDelegations = policy.delegations.filter(value => sameScope(value.scope, target) && value.subject.kind === 'role' && value.subject.id === 'member').flatMap(value => value.permissions);
      requirePermissions(policy, access, target, command.membership.role === 'admin' ? [...AGENT_PERMISSIONS] : ['members:manage', ...memberDelegations]);
      policy.memberships = [...policy.memberships.filter(value => value.teamId !== command.membership.teamId || value.userId !== command.membership.userId), command.membership]; break;
    }
    case 'removeMembership':
      requirePermissions(policy, access, { kind: 'team', teamId: command.teamId }, ['members:manage']);
      policy.memberships = policy.memberships.filter(value => value.teamId !== command.teamId || value.userId !== command.userId); break;
    case 'saveRole': {
      immutableScope(policy.roles.find(value => value.id === command.role.id), command.role);
      const delegated = policy.delegations.filter(value => value.subject.kind === 'role' && value.subject.id === command.role.id).flatMap(value => value.permissions);
      requirePermissions(policy, access, command.role.scope, ['roles:manage', ...command.role.permissions, ...delegated]);
      policy.roles = upsert(policy.roles, command.role); break;
    }
    case 'removeRole': {
      const previous = policy.roles.find(value => value.id === command.roleId);
      if (!previous) fail('Role does not exist.', 404);
      requirePermissions(policy, access, previous.scope, ['roles:manage']);
      if (policy.delegations.some(value => value.subject.kind === 'role' && value.subject.id === command.roleId)) fail('Remove the role delegations first.');
      policy.roles = policy.roles.filter(value => value.id !== command.roleId); break;
    }
    case 'saveDelegation':
      immutableScope(policy.delegations.find(value => value.id === command.delegation.id), command.delegation);
      requirePermissions(policy, access, command.delegation.scope, ['roles:manage', ...command.delegation.permissions]);
      policy.delegations = upsert(policy.delegations, command.delegation); break;
    case 'removeDelegation': {
      const previous = policy.delegations.find(value => value.id === command.delegationId);
      if (!previous) fail('Delegation does not exist.', 404);
      requirePermissions(policy, access, previous.scope, ['roles:manage']);
      policy.delegations = policy.delegations.filter(value => value.id !== command.delegationId); break;
    }
    case 'saveResource': {
      const previous = policy.resources.find(value => value.id === command.resource.id);
      immutableScope(previous, command.resource);
      if (previous && previous.kind !== command.resource.kind) fail('An existing resource cannot change kind.');
      requirePermissions(policy, access, command.resource.scope, [permissionFor(command.resource)]);
      if (command.resource.kind === 'provider') {
        if (previous?.kind === 'provider' && previous.baseUrl !== command.resource.baseUrl && command.apiToken === undefined)
          fail('Re-enter the API key when changing the provider address, or explicitly choose no API key.');
        if (command.apiToken !== undefined) secrets[command.resource.id] = command.apiToken;
        if (!Object.hasOwn(secrets, command.resource.id)) fail('Enter a provider API key, or explicitly choose no API key.');
      } else if (command.apiToken !== undefined) fail('Only providers accept API tokens.');
      policy.resources = upsert(policy.resources, command.resource); break;
    }
    case 'removeResource': {
      const previous = policy.resources.find(value => value.id === command.resourceId);
      if (!previous) fail('Resource does not exist.', 404);
      requirePermissions(policy, access, previous.scope, [permissionFor(previous)]);
      if (policy.providerGrants.some(value => value.providerId === previous.id)) fail('Remove provider audience grants before deleting it.');
      policy.resources = policy.resources.filter(value => value.id !== command.resourceId);
      delete secrets[command.resourceId]; break;
    }
    case 'saveProviderGrant': {
      const previous = policy.providerGrants.find(value => value.id === command.grant.id);
      immutableScope(previous, command.grant);
      if (previous && previous.providerId !== command.grant.providerId) fail('An existing grant cannot change providers.');
      const provider = policy.resources.find(value => value.id === command.grant.providerId && value.kind === 'provider');
      if (!provider) fail('Provider does not exist.', 404);
      requirePermissions(policy, access, provider.scope, ['providers:grant']);
      requirePermissions(policy, access, command.grant.scope, ['providers:grant']);
      policy.providerGrants = upsert(policy.providerGrants, command.grant); break;
    }
    case 'removeProviderGrant': {
      const previous = policy.providerGrants.find(value => value.id === command.grantId);
      if (!previous) fail('Provider grant does not exist.', 404);
      const provider = policy.resources.find(value => value.id === previous.providerId && value.kind === 'provider');
      if (!provider) fail('Provider does not exist.', 404);
      // Either endpoint may revoke access it previously accepted.
      if (!access.permissions(provider.scope).includes('providers:grant') && !access.permissions(previous.scope).includes('providers:grant')) fail('Permission denied for this scope.', 403);
      policy.providerGrants = policy.providerGrants.filter(value => value.id !== command.grantId); break;
    }
    default: { const exhaustive: never = command; return exhaustive; }
  }
  policy.revision++;
}

type Result<T> = { ok: true; value: T } | { ok: false; message: string; status: number };
function unwrap<T>(result: Result<T>): T {
  if (!result.ok) throw new AgentSettingsError(result.message, result.status);
  return result.value;
}
export class AgentSettingsStore {
  constructor(private readonly storage: DurableObjectStorage) {}

  async #read(storage: DurableObjectStorage | DurableObjectTransaction): Promise<Policy> {
    const stored: unknown = await storage.get(POLICY_KEY);
    return stored === undefined ? empty() : validatePolicy(stored);
  }

  async view(actor: AgentActor): Promise<AgentSettingsView> {
    const current = parsed(actorSchema, actor, 'Invalid actor.');
    return view(await this.#read(this.storage), current);
  }

  async effective(actor: AgentActor): Promise<AgentResource[]> {
    const current = parsed(actorSchema, actor, 'Invalid actor.');
    return effective(await this.#read(this.storage), current);
  }

  async mutate(actor: AgentActor, command: AgentSettingsCommand): Promise<AgentSettingsView> {
    const current = parsed(actorSchema, actor, 'Invalid actor.');
    bounded(command);
    const update = parsed(commandSchema, command, 'Invalid agent settings command.');
    const result = await this.storage.transaction<Result<AgentSettingsView>>(async storage => {
      try {
        const policy = await this.#read(storage);
        const storedSecrets: unknown = await storage.get(SECRETS_KEY);
        const secrets = storedSecrets === undefined ? {} : validateSecrets(storedSecrets, policy);
        change(policy, secrets, current, update);
        const validated = validatePolicy(policy);
        bounded(secrets);
        await storage.put({ [POLICY_KEY]: validated, [SECRETS_KEY]: secrets });
        return { ok: true, value: view(validated, current) };
      } catch (error) {
        // Expected denials leave the DO transaction gate before rejection, preserving active work.
        if (error instanceof AgentSettingsError) return { ok: false, message: error.message, status: error.status };
        throw error;
      }
    });
    return unwrap(result);
  }

  async resolveProvider(actor: AgentActor, providerId: string): Promise<{ resource: AgentResource & { kind: 'provider' }; apiToken: string } | undefined> {
    const current = parsed(actorSchema, actor, 'Invalid actor.');
    const selected = parsed(id, providerId, 'Invalid provider ID.');
    const result = await this.storage.transaction<Result<{ resource: AgentResource & { kind: 'provider' }; apiToken: string } | undefined>>(async storage => {
      try {
        const policy = await this.#read(storage);
        const provider = effective(policy, current).find(value => value.id === selected);
        if (!provider || provider.kind !== 'provider') return { ok: true, value: undefined };
        const storedSecrets: unknown = await storage.get(SECRETS_KEY);
        const secrets = validateSecrets(storedSecrets, policy);
        const apiToken = Object.hasOwn(secrets, selected) ? secrets[selected] : undefined;
        if (apiToken === undefined) fail('Provider credentials are unavailable.');
        return { ok: true, value: { resource: provider, apiToken } };
      } catch (error) {
        if (error instanceof AgentSettingsError) return { ok: false, message: error.message, status: error.status };
        throw error;
      }
    });
    return unwrap(result);
  }
}
