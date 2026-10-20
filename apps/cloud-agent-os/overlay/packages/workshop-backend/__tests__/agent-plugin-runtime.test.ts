import { env } from 'cloudflare:workers';
import type { AgentResource } from '@gadgets/workshop-shared/api';
import { describe, expect, it } from 'vitest';
import { createPortablePluginRuntime } from '../src/agent-plugin-adapter';
import { AGENT_PLUGIN_PREFIX, pluginDigest, pluginInstallationId, readPluginArtifact } from '../src/agent-plugin-artifacts';
import { resolvePackagePluginResources } from '../src/agent-plugin-runtime';

type PackagePlugin = Extract<AgentResource, { pluginId: 'package' }>;
let nextId = 0;
const syntheticModule = `let calls = 0;
export default { id: 'synthetic.portable', async setup(ctx) {
  await ctx.tool.transform(editor => {
    editor.add({name:'echo',description:'Return synthetic input',input:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
      async execute(input) { return {content: ctx.options.label + ':' + input.text + ':' + (++calls)}; }});
    editor.add({name:'temporary',description:'Removed tool',input:{type:'object'},async execute(){return {content:'removed'};}});
    editor.remove('temporary');
    editor.update('echo', tool => { tool.description = 'Echo synthetic text'; });
  });
  await ctx.session.hook('context', event => event.system.push({type:'text',text:'Plugin context: ' + ctx.options.label}));
} };`;

async function installed(module = syntheticModule, execution: 'host' | 'dynamic' = 'dynamic') {
  const resource = { id: `synthetic-plugin-${++nextId}`, name: 'Synthetic plugin', kind: 'plugin', pluginId: 'package', enabled: true,
    scope: { kind: 'organization' }, source: { kind: 'npm', name: 'synthetic-plugin', version: '1.0.0' }, execution,
    options: JSON.stringify({ label: 'approved' }) } satisfies PackagePlugin;
  const raw = JSON.stringify({ apiVersion: 1, source: resource.source, module,
    packageIntegrity: `sha256-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('synthetic package')))))}`,
    lockDigest: await pluginDigest('synthetic lockfile') });
  const digest = await pluginDigest(raw);
  await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}artifacts/${digest}.json`, raw);
  const id = await pluginInstallationId(resource);
  await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}results/${id}.json`, JSON.stringify({ apiVersion: 1, id,
    status: 'ready', artifactDigest: digest, error: null, updatedAt: new Date().toISOString() }));
  let current: AgentResource | undefined = resource;
  const resolve = () => resolvePackagePluginResources({ resources: [resource], loadResource: async () => current,
    services: { bucket: env.BLUEPRINT_CONTENT, loader: env.LOADER, principal: `synthetic-principal-${resource.id}` } });
  return { resource, digest, resolve, change(value: AgentResource | undefined) { current = value; } };
}

describe('portable package plugins through the real Worker Loader and R2', () => {
  it('uses native v2 tool transforms and context hooks in the isolated module', async () => {
    const fixture = await installed();
    const result = await fixture.resolve();
    expect(result.prompt).toBe('Plugin context: approved');
    expect(result.tools).toHaveLength(1);
    const [tool] = result.tools;
    expect(tool.name).toMatch(/^plugin_[a-f0-9]{16}_echo$/);
    expect(tool.description).toBe('Echo synthetic text');
    expect(await tool.execute('synthetic-call', { text: 'hello' })).toMatchObject({ content: [{ type: 'text', text: 'approved:hello:1' }] });
    await expect(tool.execute('invalid', { unknown: 'missing required text' })).rejects.toThrow();
    expect(await tool.execute('second-valid', { text: 'again' })).toMatchObject({ content: [{ type: 'text', text: 'approved:again:2' }] });
  });

  it('rechecks current permission, source, options, and installation before running a cached tool', async () => {
    const fixture = await installed();
    const [tool] = (await fixture.resolve()).tools;
    fixture.change(undefined);
    await expect(tool.execute('revoked', { text: 'never' })).rejects.toThrow('access revoked');
    fixture.change({ ...fixture.resource, options: JSON.stringify({ label: 'changed' }) });
    await expect(tool.execute('changed-options', { text: 'never' })).rejects.toThrow('access revoked');
    fixture.change({ ...fixture.resource, source: { ...fixture.resource.source, version: '2.0.0' } });
    await expect(tool.execute('changed-version', { text: 'never' })).rejects.toThrow('access revoked');
    fixture.change(fixture.resource);
    expect(await tool.execute('restored', { text: 'allowed' })).toMatchObject({ content: [{ type: 'text', text: 'approved:allowed:1' }] });
  });

  it('rejects altered R2 artifacts and does not silently run host packages dynamically', async () => {
    const corrupt = await installed();
    await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}artifacts/${corrupt.digest}.json`, '{}');
    await expect(readPluginArtifact(env.BLUEPRINT_CONTENT, corrupt.digest)).rejects.toThrow('integrity');
    expect(await corrupt.resolve()).toMatchObject({ tools: [], prompt: expect.stringContaining('is unavailable') });
    const host = await installed(syntheticModule, 'host');
    expect(await host.resolve()).toEqual({ tools: [], prompt: '' });
  });

  it('denies network access and unsupported native domains with an explicit compatibility failure', async () => {
    const unsupported = await installed(`export const Plugin={id:'synthetic.unsupported',setup(ctx){ctx.storage.get('not-supported');}}`);
    expect(await unsupported.resolve()).toMatchObject({ tools: [], prompt: expect.stringContaining('portable API compatibility') });
    const network = await installed(`export default {id:'synthetic.network',async setup(ctx){await ctx.tool.transform(e=>e.add({name:'network',description:'Denied network',input:{type:'object'},async execute(){await fetch('https://example.invalid/');return {content:'unexpected'};}}));}}`);
    const [tool] = (await network.resolve()).tools;
    await expect(tool.execute('network-denied', {})).rejects.toThrow('unsupported API');
  });

  it('bounds plugin prompts and descriptors before exposing them to the agent', async () => {
    const fixture = await installed(`export default {id:'synthetic.large',async setup(ctx){await ctx.session.hook('context',e=>e.system.push({type:'text',text:'x'.repeat(16001)}));}}`);
    expect(await fixture.resolve()).toMatchObject({ tools: [], prompt: expect.stringContaining('is unavailable') });
  });

  it('keeps long native tool names inside provider name limits without losing execution routing', async () => {
    const fixture = await installed(`export default {id:'synthetic.long-name',async setup(ctx){await ctx.tool.transform(e=>e.add({name:'${'a'.repeat(64)}',description:'Long name',input:{type:'object'},async execute(){return {content:'routed'};}}));}}`);
    const [tool] = (await fixture.resolve()).tools;
    expect(tool.name).toHaveLength(64);
    expect(await tool.execute('long-name', {})).toMatchObject({ content: [{ type: 'text', text: 'routed' }] });
  });

  it('preserves valid sibling tools when another installed package is invalid', async () => {
    const invalid = await installed(`export default {id:'synthetic.invalid',setup(ctx){ctx.provider.list();}}`);
    const valid = await installed();
    const resources = [invalid.resource, valid.resource];
    const result = await resolvePackagePluginResources({ resources, loadResource: async id => resources.find(resource => resource.id === id),
      services: { bucket: env.BLUEPRINT_CONTENT, loader: env.LOADER, principal: 'synthetic-sibling-check' } });
    expect(result.tools).toHaveLength(1);
    expect(result.prompt).toContain('is unavailable');
    expect(result.prompt).toContain('Plugin context: approved');
    expect(await result.tools[0].execute('sibling', { text: 'valid' })).toMatchObject({ content: [{ type: 'text', text: 'approved:valid:1' }] });
  });

  it('rejects cleanup-returning native plugins before exposing their tools', async () => {
    const module = { default: { id: 'synthetic.cleanup', setup() { return () => {}; } } };
    await expect(createPortablePluginRuntime(module, '{}')).rejects.toThrow('cleanup lifecycle is unsupported');
    const fixture = await installed(`export default {id:'synthetic.cleanup',async setup(ctx){await ctx.tool.transform(e=>e.add({name:'unsafeLifecycle',description:'Unsupported cleanup',input:{type:'object'},async execute(){return {content:'must not run'};}}));return ()=>{};}}`);
    expect(await fixture.resolve()).toMatchObject({ tools: [], prompt: expect.stringContaining('portable API compatibility') });
  });
});

it('uses the same portable adapter for trusted host modules', async () => {
  const module = { Plugin: { id: 'synthetic.host', async setup(ctx: { tool: { transform: (callback: (editor: { add: (tool: unknown) => void }) => void) => Promise<void> } }) {
    await ctx.tool.transform(editor => editor.add({ name: 'host', description: 'Synthetic host tool', input: { type: 'object' },
      async execute() { return { content: [{ type: 'text', text: 'host result' }] }; } }));
  } } };
  const runtime = await createPortablePluginRuntime(module, '{}');
  expect(runtime.describe().map(tool => tool.name)).toEqual(['host']);
  expect(await runtime.execute('host', {}, 'synthetic')).toBe('host result');
});

it('rejects non-object, non-finite, oversized and deeply nested JSON options before calling a host plugin', async () => {
  let called = false;
  const module = { default: { id: 'synthetic.options', setup() { called = true; } } };
  for (const options of ['[]', '{"n":1e999}', JSON.stringify({ text: 'x'.repeat(16_384) }), '{"x":'.repeat(18) + 'null' + '}'.repeat(18)]) {
    await expect(createPortablePluginRuntime(module, options)).rejects.toThrow();
  }
  expect(called).toBe(false);
});
