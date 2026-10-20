import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { AgentPluginArtifact, AgentSettingsView } from '@gadgets/workshop-shared/agent-settings';
import { AGENT_PLUGIN_PREFIX, AgentPluginInstallations, canonicalPluginSource, pluginDigest, pluginInstallationId, readPluginArtifact, readPluginResult, type PackageAgentPlugin } from '../src/agent-plugin-artifacts';

const resource = (): PackageAgentPlugin => ({ id: crypto.randomUUID(), name: 'Example package', kind: 'plugin', pluginId: 'package',
  scope: { kind: 'organization' }, source: { kind: 'bundle', digest: 'a'.repeat(64) }, execution: 'dynamic', enabled: true, options: '{}' });
const artifact = (): AgentPluginArtifact => ({ apiVersion: 1, source: { kind: 'bundle', digest: 'a'.repeat(64) },
  module: 'export default { id: "fixture", setup() {} };', packageIntegrity: null, lockDigest: null });
const view = (plugin: PackageAgentPlugin): AgentSettingsView => ({ revision: 1, easyMode: true, viewerId: 'fixture-user',
  scopes: [], teams: [], memberships: [], roles: [], delegations: [], resources: [plugin], effectiveResources: [plugin], providerGrants: [],
  canManagePluginExecution: false, pluginReviews: [], pluginInstallations: [], pluginInstallerError: null });
async function approved(plugin: PackageAgentPlugin) {
  if (plugin.execution === 'pending') throw new Error('Test requires approved execution.');
  return { id: plugin.id, source: plugin.source, execution: plugin.execution };
}

describe('plugin artifacts and installation publication', () => {
  it('binds installation identity to exact source and host, independent of property order', async () => {
    const selected = await approved(resource());
    expect(await pluginInstallationId(selected)).toBe(await pluginInstallationId({ ...selected, source: { digest: 'a'.repeat(64), kind: 'bundle' } }));
    expect(await pluginInstallationId(selected)).not.toBe(await pluginInstallationId({ ...selected, execution: 'host' }));
    expect(await pluginInstallationId(selected)).not.toBe(await pluginInstallationId({ ...selected, source: { kind: 'bundle', digest: 'b'.repeat(64) } }));
    expect(() => canonicalPluginSource({ kind: 'npm', name: 'fixture', version: '1.2.3-01' })).toThrow();
    expect(canonicalPluginSource({ kind: 'npm', name: '@fixture/plugin', version: '1.2.3-alpha-01+01' })).toEqual({ kind: 'npm', name: '@fixture/plugin', version: '1.2.3-alpha-01+01' });
  });

  it('publishes immutable requests before desired state and removes disabled or unapproved selections', async () => {
    const plugin = resource();
    const pending = { ...resource(), execution: 'pending' } satisfies PackageAgentPlugin;
    const disabled = { ...resource(), enabled: false };
    const store = new AgentPluginInstallations(env.BLUEPRINT_CONTENT, {});
    await store.sync(async () => ({ apiVersion: 1, revision: 3, plugins: [plugin, pending, disabled] }));
    const selected = await approved(plugin);
    const id = await pluginInstallationId(selected);
    const request = await env.BLUEPRINT_CONTENT.get(`${AGENT_PLUGIN_PREFIX}requests/${id}.json`);
    expect(await request?.json()).toEqual({ apiVersion: 1, id, resourceId: plugin.id, source: plugin.source, execution: 'dynamic' });
    const desired = await env.BLUEPRINT_CONTENT.get(`${AGENT_PLUGIN_PREFIX}desired.json`);
    expect(await desired?.json()).toEqual({ apiVersion: 1, revision: 3, plugins: [plugin] });
    await store.sync(async () => ({ apiVersion: 1, revision: 4, plugins: [] }));
    expect(await (await env.BLUEPRINT_CONTENT.get(`${AGENT_PLUGIN_PREFIX}desired.json`))?.json()).toEqual({ apiVersion: 1, revision: 4, plugins: [] });
  });

  it('rejects an existing request with mismatched identity and allows a fresh valid publication', async () => {
    const plugin = resource();
    const id = await pluginInstallationId(await approved(plugin));
    await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}requests/${id}.json`, '{}');
    const store = new AgentPluginInstallations(env.BLUEPRINT_CONTENT, {});
    await expect(store.sync(async () => ({ apiVersion: 1, revision: 5, plugins: [plugin] }))).rejects.toThrow('identity check');
    const replacement = resource();
    await store.sync(async () => ({ apiVersion: 1, revision: 6, plugins: [replacement] }));
    expect(await (await env.BLUEPRINT_CONTENT.get(`${AGENT_PLUGIN_PREFIX}desired.json`))?.json()).toEqual({ apiVersion: 1, revision: 6, plugins: [replacement] });
  });

  it('validates the exact artifact bytes and source provenance', async () => {
    const raw = JSON.stringify(artifact());
    const digest = await pluginDigest(raw);
    const key = `${AGENT_PLUGIN_PREFIX}artifacts/${digest}.json`;
    await env.BLUEPRINT_CONTENT.put(key, raw);
    expect(await readPluginArtifact(env.BLUEPRINT_CONTENT, digest)).toEqual(artifact());
    await env.BLUEPRINT_CONTENT.put(key, `${raw} `);
    await expect(readPluginArtifact(env.BLUEPRINT_CONTENT, digest)).rejects.toThrow('integrity check');
    const invalid = JSON.stringify({ ...artifact(), source: { kind: 'npm', name: 'fixture', version: '1.0.0' } });
    const invalidDigest = await pluginDigest(invalid);
    await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}artifacts/${invalidDigest}.json`, invalid);
    await expect(readPluginArtifact(env.BLUEPRINT_CONTENT, invalidDigest)).rejects.toThrow('provenance');
    for (const packageIntegrity of ['sha1-' + btoa('x'.repeat(20)), 'sha256-c3ludGhldGlj', 'sha256-' + btoa('x'.repeat(31))]) {
      const raw = JSON.stringify({ ...artifact(), source: { kind: 'npm', name: 'fixture', version: '1.0.0' }, packageIntegrity, lockDigest: 'b'.repeat(64) });
      const digest = await pluginDigest(raw);
      await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}artifacts/${digest}.json`, raw);
      await expect(readPluginArtifact(env.BLUEPRINT_CONTENT, digest)).rejects.toThrow('provenance');
    }
    const npm = { ...artifact(), source: { kind: 'npm', name: 'fixture', version: '1.0.0' }, packageIntegrity: 'sha256-' + btoa('x'.repeat(32)), lockDigest: 'b'.repeat(64) };
    const npmRaw = JSON.stringify(npm);
    const npmDigest = await pluginDigest(npmRaw);
    await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}artifacts/${npmDigest}.json`, npmRaw);
    expect(await readPluginArtifact(env.BLUEPRINT_CONTENT, npmDigest)).toEqual(npm);
  });

  it('requires a matching result and compiled host inventory before reporting active', async () => {
    const plugin = { ...resource(), execution: 'host' } satisfies PackageAgentPlugin;
    const selected = await approved(plugin);
    const id = await pluginInstallationId(selected);
    expect((await readPluginResult(env.BLUEPRINT_CONTENT, selected)).status).toBe('queued');
    const artifactDigest = 'b'.repeat(64);
    const result = { apiVersion: 1, id, status: 'ready', artifactDigest, error: null, updatedAt: new Date().toISOString() };
    await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}results/${id}.json`, JSON.stringify(result));
    expect((await new AgentPluginInstallations(env.BLUEPRINT_CONTENT, {}).view(view(plugin))).pluginInstallations[0].status).toBe('ready');
    expect((await new AgentPluginInstallations(env.BLUEPRINT_CONTENT, { [artifactDigest]: () => {} }).view(view(plugin))).pluginInstallations[0].status).toBe('active');
    await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}results/${id}.json`, JSON.stringify({ ...result, id: 'c'.repeat(64) }));
    await expect(readPluginResult(env.BLUEPRINT_CONTENT, selected)).rejects.toThrow('does not match');
    const unavailable = await new AgentPluginInstallations(env.BLUEPRINT_CONTENT, {}).view(view(plugin));
    expect(unavailable.pluginInstallations).toEqual([]);
    expect(unavailable.pluginInstallerError).toContain('unavailable');
  });
});
