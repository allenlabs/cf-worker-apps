import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { AGENT_PERMISSIONS, type AgentResource, type AgentScope, type AgentSettingsCommand } from '@gadgets/workshop-shared/agent-settings';
import { AgentSettingsStore, validateAgentEndpoint, validateAgentTeamGraph, type AgentActor } from '../src/agent-settings.js';
import type { UserDirectoryDurableObject } from '../src/user-directory.js';
import './test-worker.js';

declare module 'cloudflare:workers' {
  interface ProvidedEnv { TEST_USER_DIRECTORY: DurableObjectNamespace<UserDirectoryDurableObject>; }
}
const admin: AgentActor = { userId: 'org-admin', organizationAdmin: true };
const alice: AgentActor = { userId: 'alice', organizationAdmin: false };
const bob: AgentActor = { userId: 'bob', organizationAdmin: false };
const org: AgentScope = { kind: 'organization' };
const personal = (userId: string): AgentScope => ({ kind: 'personal', userId });
const teamScope = (teamId: string): AgentScope => ({ kind: 'team', teamId });
const skill = (id: string, scope: AgentScope): AgentResource => ({ id, scope, kind: 'skill', name: id, enabled: true, description: '', content: 'Use clear instructions.' });
const provider = (id: string, scope: AgentScope): AgentResource => ({ id, scope, kind: 'provider', name: id, enabled: true, baseUrl: 'https://api.example.com/v1' });
type WithoutRevision<T> = T extends unknown ? Omit<T, 'expectedRevision'> : never;
type Change = WithoutRevision<AgentSettingsCommand>;
function fixture() {
  const stub = env.TEST_USER_DIRECTORY.getByName(`agent-settings-${crypto.randomUUID()}`);
  const inStore = <T>(fn: (store: AgentSettingsStore, storage: DurableObjectStorage) => T | Promise<T>) => runInDurableObject(stub, (_host, state) => fn(new AgentSettingsStore(state.storage), state.storage));
  const view = (actor: AgentActor) => inStore(store => store.view(actor));
  const update = async (actor: AgentActor, command: Change) => {
    const current = await view(actor);
    return inStore(store => store.mutate(actor, { ...command, expectedRevision: current.revision }));
  };
  const team = (id: string, parentId: string | null = null) => update(admin, { type: 'saveTeam', team: { id, name: id, parentId } });
  const member = (teamId: string, userId: string, role: 'admin' | 'member' = 'member') => update(admin, { type: 'saveMembership', membership: { teamId, userId, role } });
  return { inStore, view, update, team, member };
}
async function denied(call: Promise<unknown>, message = 'Permission denied') {
  let caught: unknown;
  try { await call; } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(String(caught)).toContain(message);
}

describe('scoped agent policy', () => {
  it('requires a new explicit secret when an editor changes the provider endpoint', async () => {
    const f = fixture();
    await f.team('private-team');
    await f.member('private-team', 'bob');
    await f.update(admin, { type: 'saveResource', resource: provider('private-provider', teamScope('private-team')), apiToken: 'synthetic-original-key' });
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'provider-editor', scope: teamScope('private-team'), subject: { kind: 'user', id: 'alice' }, permissions: ['providers:manage'] } });
    const current = await f.view(admin);
    const replacement: AgentResource = { ...provider('private-provider', teamScope('private-team')), kind: 'provider', baseUrl: 'https://replacement.example.com/v1' };
    await denied(f.update(alice, { type: 'saveResource', resource: replacement }), 'Re-enter the API key');
    expect((await f.view(admin)).revision).toBe(current.revision);
    expect((await f.inStore(store => store.resolveProvider(bob, 'private-provider')))?.apiToken).toBe('synthetic-original-key');
    await f.update(alice, { type: 'saveResource', resource: replacement, apiToken: 'synthetic-replacement-key' });
    expect((await f.inStore(store => store.resolveProvider(bob, 'private-provider')))?.apiToken).toBe('synthetic-replacement-key');
    await f.update(alice, { type: 'saveResource', resource: { ...replacement, baseUrl: 'https://keyless.example.com/v1' }, apiToken: '' });
    expect((await f.inStore(store => store.resolveProvider(bob, 'private-provider')))?.apiToken).toBe('');
  });

  it('rejects missing parents, cycles, and duplicate teams', () => {
    expect(() => validateAgentTeamGraph([{ id: 'child', name: 'Child', parentId: 'root' }, { id: 'root', name: 'Root', parentId: null }])).not.toThrow();
    expect(() => validateAgentTeamGraph([{ id: 'child', name: 'Child', parentId: 'missing' }])).toThrow('parent');
    expect(() => validateAgentTeamGraph([{ id: 'a', name: 'A', parentId: 'b' }, { id: 'b', name: 'B', parentId: 'a' }])).toThrow('cycle');
    expect(() => validateAgentTeamGraph([{ id: 'a', name: 'A', parentId: null }, { id: 'a', name: 'A', parentId: null }])).toThrow('Duplicate');
  });

  it('accepts HTTPS endpoints and rejects credentials, internal literals, ports, and URL tricks', () => {
    expect(validateAgentEndpoint('https://api.example.com/v1')).toBe(true);
    for (const value of ['http://api.example.com', 'https://user:secret@api.example.com', 'https://127.0.0.1/v1', 'https://0x7f000001/v1', 'https://[::1]/v1', 'https://metadata.internal/v1', 'https://localhost./v1', 'https://api.example.com:8443/v1', 'https://api.example.com/v1?token=secret', 'https://api.example.com/v1#@public.example.com', 'https://api.example.com/v1?', 'https://api.example.com/v1#', 'https://api.exa\nmple.com/v1']) expect(validateAgentEndpoint(value)).toBe(false);
  });

  it('keeps personal administration private, even from bootstrap org admins', async () => {
    const f = fixture();
    await f.update(alice, { type: 'saveResource', resource: skill('alice-private', personal('alice')) });
    expect((await f.view(admin)).resources).toEqual([]);
    expect((await f.view(bob)).resources).toEqual([]);
    await denied(f.update(admin, { type: 'saveResource', resource: skill('alice-private', personal('alice')) }));
    await f.update(alice, { type: 'saveDelegation', delegation: { id: 'personal-admin', scope: personal('alice'), subject: { kind: 'user', id: admin.userId }, permissions: [...AGENT_PERMISSIONS] } });
    expect((await f.view(admin)).resources.map(value => value.id)).toEqual(['alice-private']);
    await f.update(admin, { type: 'saveResource', resource: skill('alice-second', personal('alice')) });
    expect(await f.inStore(store => store.effective(admin))).toEqual([]);
  });

  it('unions multiple memberships and inherits ancestors without exposing siblings or children', async () => {
    const f = fixture();
    await f.team('root'); await f.team('child', 'root'); await f.team('sibling', 'root'); await f.team('other');
    for (const id of ['root', 'child', 'sibling', 'other']) await f.update(admin, { type: 'saveResource', resource: skill(`skill-${id}`, teamScope(id)) });
    await f.member('child', 'alice'); await f.member('other', 'alice'); await f.member('root', 'bob');
    expect((await f.inStore(store => store.effective(alice))).map(value => value.id)).toEqual(['skill-root', 'skill-child', 'skill-other']);
    expect((await f.view(alice)).resources.map(value => value.id)).not.toContain('skill-sibling');
    expect((await f.inStore(store => store.effective(bob))).map(value => value.id)).toEqual(['skill-root']);
    expect(await f.inStore(store => store.effective(admin))).toEqual([]);
    expect((await f.view(admin)).resources).toHaveLength(4);
    expect((await f.view(alice)).memberships.every(value => value.userId === 'alice')).toBe(true);
  });

  it('lets team admins administer descendants and create children while other teams stay protected', async () => {
    const f = fixture();
    await f.team('root'); await f.team('child', 'root'); await f.team('outside'); await f.member('root', 'alice', 'admin');
    await f.update(alice, { type: 'saveResource', resource: skill('child-skill', teamScope('child')) });
    await f.update(alice, { type: 'saveTeam', team: { id: 'new-child', name: 'New child', parentId: 'child' } });
    await denied(f.update(alice, { type: 'saveResource', resource: skill('outside-skill', teamScope('outside')) }));
    await denied(f.update(alice, { type: 'saveTeam', team: { id: 'root', name: 'Root', parentId: 'outside' } }), 'cannot change parents');
  });

  it('gives explicitly delegated org and team administrators inherited team authority without personal access', async () => {
    const f = fixture(); await f.team('root'); await f.team('child', 'root'); await f.team('outside');
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'org-admin-alice', scope: org, subject: { kind: 'user', id: 'alice' }, permissions: [...AGENT_PERMISSIONS] } });
    await f.update(alice, { type: 'saveResource', resource: skill('delegated-org-child', teamScope('child')) });
    await denied(f.update(alice, { type: 'saveResource', resource: skill('bob-private', personal('bob')) }));
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'team-admin-bob', scope: teamScope('root'), subject: { kind: 'user', id: 'bob' }, permissions: [...AGENT_PERMISSIONS] } });
    await f.update(bob, { type: 'saveResource', resource: skill('delegated-team-child', teamScope('child')) });
    await denied(f.update(bob, { type: 'saveResource', resource: skill('outside-denied', teamScope('outside')) }));
    await f.update(admin, { type: 'removeDelegation', delegationId: 'org-admin-alice' });
    await denied(f.update(alice, { type: 'saveResource', resource: skill('delegated-org-child', teamScope('child')) }));
  });

  it('applies custom-role delegations immediately and revokes current write authority', async () => {
    const f = fixture(); await f.team('engineering');
    await f.update(admin, { type: 'saveRole', role: { id: 'provider-operators', name: 'Provider operators', scope: teamScope('engineering'), members: ['alice'], permissions: [] } });
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'provider-writers', scope: teamScope('engineering'), subject: { kind: 'role', id: 'provider-operators' }, permissions: ['providers:manage'] } });
    await f.update(alice, { type: 'saveResource', resource: provider('team-provider', teamScope('engineering')), apiToken: 'synthetic-key' });
    expect((await f.view(alice)).resources.map(value => value.id)).toEqual(['team-provider']);
    expect(await f.inStore(store => store.resolveProvider(alice, 'team-provider'))).toBeUndefined();
    await f.update(admin, { type: 'removeDelegation', delegationId: 'provider-writers' });
    await denied(f.update(alice, { type: 'saveResource', resource: provider('team-provider', teamScope('engineering')) }));
  });

  it('bounds role membership and delegation edits by every permission they assign', async () => {
    const f = fixture(); await f.team('engineering');
    await f.update(admin, { type: 'saveRole', role: { id: 'secret-granters', name: 'Granters', scope: teamScope('engineering'), members: ['bob'], permissions: [] } });
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'grant-authority', scope: teamScope('engineering'), subject: { kind: 'role', id: 'secret-granters' }, permissions: ['providers:grant'] } });
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'role-editor', scope: teamScope('engineering'), subject: { kind: 'user', id: 'alice' }, permissions: ['roles:manage'] } });
    await denied(f.update(alice, { type: 'saveRole', role: { id: 'secret-granters', name: 'Granters', scope: teamScope('engineering'), members: ['bob', 'alice'], permissions: [] } }));
    await denied(f.update(alice, { type: 'saveRole', role: { id: 'escalate', name: 'Escalate', scope: teamScope('engineering'), members: ['alice'], permissions: ['providers:manage'] } }));
    await denied(f.update(alice, { type: 'saveDelegation', delegation: { id: 'escalate', scope: teamScope('engineering'), subject: { kind: 'user', id: 'alice' }, permissions: ['providers:grant'] } }));
    await denied(f.update(admin, { type: 'saveDelegation', delegation: { id: 'wrong-scope', scope: org, subject: { kind: 'role', id: 'secret-granters' }, permissions: ['providers:grant'] } }), 'same scope');
  });

  it('bounds standard memberships by delegated member permissions and denies admin escalation', async () => {
    const f = fixture(); await f.team('engineering');
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'member-editors', scope: teamScope('engineering'), subject: { kind: 'user', id: 'alice' }, permissions: ['members:manage'] } });
    await f.update(alice, { type: 'saveMembership', membership: { teamId: 'engineering', userId: 'bob', role: 'member' } });
    await denied(f.update(alice, { type: 'saveMembership', membership: { teamId: 'engineering', userId: 'alice', role: 'admin' } }));
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'member-grants', scope: teamScope('engineering'), subject: { kind: 'role', id: 'member' }, permissions: ['providers:grant'] } });
    await denied(f.update(alice, { type: 'saveMembership', membership: { teamId: 'engineering', userId: 'alice', role: 'member' } }));
    expect((await f.view(alice)).scopes.find(value => value.scope.kind === 'team')?.permissions).toEqual(['members:manage']);
    expect((await f.view(bob)).scopes.find(value => value.scope.kind === 'team')?.permissions).toEqual(['providers:grant']);
  });

  it('prevents existing resource, role, delegation and grant IDs from moving scopes', async () => {
    const f = fixture(); await f.team('team');
    await f.update(admin, { type: 'saveResource', resource: skill('fixed-resource', org) });
    await denied(f.update(admin, { type: 'saveResource', resource: skill('fixed-resource', teamScope('team')) }), 'cannot move');
    await f.update(admin, { type: 'saveRole', role: { id: 'fixed-role', name: 'Role', scope: org, members: [], permissions: [] } });
    await denied(f.update(admin, { type: 'saveRole', role: { id: 'fixed-role', name: 'Role', scope: teamScope('team'), members: [], permissions: [] } }), 'cannot move');
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'fixed-delegation', scope: org, subject: { kind: 'user', id: 'alice' }, permissions: [] } });
    await denied(f.update(admin, { type: 'saveDelegation', delegation: { id: 'fixed-delegation', scope: teamScope('team'), subject: { kind: 'user', id: 'alice' }, permissions: [] } }), 'cannot move');
    await f.update(admin, { type: 'saveResource', resource: provider('fixed-provider', org), apiToken: 'synthetic-key' });
    await f.update(admin, { type: 'saveProviderGrant', grant: { id: 'fixed-grant', providerId: 'fixed-provider', scope: teamScope('team'), enabled: true } });
    await denied(f.update(admin, { type: 'saveProviderGrant', grant: { id: 'fixed-grant', providerId: 'fixed-provider', scope: org, enabled: true } }), 'cannot move');
  });

  it('requires grant authority at source and audience, hides secrets, and revokes inference immediately', async () => {
    const f = fixture();
    await f.update(alice, { type: 'saveResource', resource: provider('personal-provider', personal('alice')), apiToken: 'synthetic-private-key' });
    const grant = { id: 'share-provider', providerId: 'personal-provider', scope: org, enabled: true };
    await denied(f.update(alice, { type: 'saveProviderGrant', grant }));
    await denied(f.update(admin, { type: 'saveProviderGrant', grant }));
    await f.update(admin, { type: 'saveDelegation', delegation: { id: 'audience-admin', scope: org, subject: { kind: 'user', id: 'alice' }, permissions: ['providers:grant'] } });
    await f.update(alice, { type: 'saveProviderGrant', grant });
    expect((await f.view(bob)).effectiveResources.map(value => value.id)).toEqual(['personal-provider']);
    expect(JSON.stringify(await f.view(bob))).not.toContain('synthetic-private-key');
    expect(JSON.stringify(await f.inStore((_store, storage) => storage.get('agent-settings.policy.v1')))).not.toContain('synthetic-private-key');
    expect((await f.inStore(store => store.resolveProvider(bob, 'personal-provider')))?.apiToken).toBe('synthetic-private-key');
    await denied(f.update(alice, { type: 'removeResource', resourceId: 'personal-provider' }), 'grants');
    await f.update(admin, { type: 'removeProviderGrant', grantId: 'share-provider' });
    expect(await f.inStore(store => store.resolveProvider(bob, 'personal-provider'))).toBeUndefined();
    await f.update(alice, { type: 'removeResource', resourceId: 'personal-provider' });
    expect(await f.inStore((_store, storage) => storage.get('agent-settings.secrets.v1'))).toEqual({});
  });

  it('uses identical easy and advanced permissions and reserves global mode to org authority', async () => {
    const f = fixture();
    await denied(f.update(alice, { type: 'setMode', easyMode: false }));
    await f.update(admin, { type: 'setMode', easyMode: false });
    expect((await f.view(alice)).easyMode).toBe(false);
    await denied(f.update(alice, { type: 'saveResource', resource: skill('org-skill', org) }));
    await f.update(admin, { type: 'setMode', easyMode: true });
    await denied(f.update(alice, { type: 'saveResource', resource: skill('org-skill', org) }));
  });

  it('serializes revisions and keeps policy and credentials atomic after rejected updates', async () => {
    const f = fixture();
    const results = await f.inStore(store => Promise.allSettled([
      store.mutate(alice, { type: 'saveResource', expectedRevision: 0, resource: provider('first', personal('alice')), apiToken: 'first-key' }),
      store.mutate(alice, { type: 'saveResource', expectedRevision: 0, resource: provider('second', personal('alice')), apiToken: 'second-key' }),
    ]));
    expect(results.map(value => value.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await f.view(alice)).revision).toBe(1);
    expect((await f.view(alice)).resources).toHaveLength(1);
    const before = await f.inStore((_store, storage) => storage.list());
    await denied(f.update(alice, { type: 'saveResource', resource: provider('invalid-team', teamScope('missing')), apiToken: 'discard-key' }), 'Team does not exist');
    expect(await f.inStore((_store, storage) => storage.list())).toEqual(before);
  });

  it('rejects stored policy above team, membership and resource count limits', async () => {
    const base = { revision: 0, easyMode: true, teams: [], memberships: [], roles: [], delegations: [], resources: [], providerGrants: [] };
    for (const stored of [
      { ...base, teams: Array.from({ length: 201 }, (_, i) => ({ id: `team-${i}`, name: 'Team', parentId: null })) },
      { ...base, teams: [{ id: 'team', name: 'Team', parentId: null }], memberships: Array.from({ length: 2001 }, (_, i) => ({ teamId: 'team', userId: `user-${i}`, role: 'member' })) },
      { ...base, resources: Array.from({ length: 501 }, (_, i) => skill(`skill-${i}`, org)) },
    ]) {
      const f = fixture();
      await f.inStore((_store, storage) => storage.put('agent-settings.policy.v1', stored));
      await denied(f.view(alice), 'Stored agent settings are invalid');
    }
  });

  it('validates untrusted commands and stored state with bounded content', async () => {
    const f = fixture();
    await denied(f.inStore(store => Reflect.apply(store.mutate, store, [alice, { type: 'saveResource', expectedRevision: 0, resource: { ...provider('bad', personal('alice')), baseUrl: 'https://user:secret@api.example.com' }, apiToken: 'never-print-key' }])), 'Invalid agent settings command');
    await denied(f.update(alice, { type: 'saveResource', resource: { id: 'too-large', name: 'Too large', scope: personal('alice'), enabled: true, kind: 'skill', description: '', content: 'x'.repeat(16_385) } }), 'Invalid agent settings command');
    expect((await f.view(alice)).revision).toBe(0);
    await f.inStore((_store, storage) => storage.put('agent-settings.policy.v1', { revision: 5, easyMode: true, teams: [{ id: 'orphan', name: 'Orphan', parentId: 'missing' }], memberships: [], roles: [], delegations: [], resources: [], providerGrants: [] }));
    await denied(f.view(alice), 'Team parent does not exist');
  });
});
