import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai';
import type { Message, ToolResultMessage } from '@earendil-works/pi-ai';
import type { AgentResource, AiToolCall } from '@gadgets/workshop-shared/api';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { makeStoredAssistantMessage, rehydrateStoredAssistantMessage } from '../src/agent';
import { AGENT_PLUGIN_PREFIX, pluginDigest, pluginInstallationId } from '../src/agent-plugin-artifacts';
import { resolvePackagePluginResources } from '../src/agent-plugin-runtime';
import { runOpenCodeLoop } from '../src/opencode-loop';
import type { StoredAssistantMessage } from '../src/storage-schema/overseer-storage';
import './test-worker';

const resource = { id: 'synthetic-canonical-package', name: 'Canonical package', scope: { kind: 'organization' },
  enabled: true, kind: 'plugin', pluginId: 'package', execution: 'dynamic',
  source: { kind: 'npm', name: 'synthetic-canonical-package', version: '1.0.0' }, options: '{}' } satisfies AgentResource;
const module = `export default {id:'synthetic.canonical',async setup(ctx){
  await ctx.tool.transform(editor=>editor.add({name:'canonical',description:'Synthetic canonical tool',
    input:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},
    async execute(input){return {content:'Canonical package result: '+input.text};}}));
  await ctx.session.hook('context',event=>event.system.push({type:'text',text:'Canonical package context is active.'}));
}};`;
type PersistedStep = { assistant: StoredAssistantMessage; toolCalls: AiToolCall[]; results: ToolResultMessage[] };

it('delivers package hooks and tools through the canonical model transport and replays its durable result', async () => {
  const integrity = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('synthetic canonical package')))));
  const artifact = JSON.stringify({ apiVersion: 1, source: resource.source, module, packageIntegrity: `sha256-${integrity}`,
    lockDigest: await pluginDigest('synthetic canonical lockfile') });
  const digest = await pluginDigest(artifact), id = await pluginInstallationId(resource);
  await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}artifacts/${digest}.json`, artifact);
  await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}results/${id}.json`, JSON.stringify({ apiVersion: 1, id,
    status: 'ready', artifactDigest: digest, error: null, updatedAt: new Date().toISOString() }));
  const toolName: `plugin_${string}` = `plugin_${(await pluginDigest(resource.id)).slice(0, 16)}_canonical`;
  const initial: Message[] = [{ role: 'system', content: 'Pinned OS policy.', timestamp: 0 },
    { role: 'user', content: 'Run the configured package tool.', timestamp: 0 }];

  await runInDurableObject(env.TEST_OVERSEER.getByName('canonical-package-loop'), async (_instance, state) => {
    const packagePlugins = await resolvePackagePluginResources({ resources: [resource], loadResource: async () => resource,
      services: { bucket: env.BLUEPRINT_CONTENT, loader: env.LOADER, principal: 'synthetic-canonical-owner' } });
    expect(packagePlugins.tools.map(tool => tool.name)).toEqual([toolName]);
    const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
    const trace: string[] = [];
    faux.setResponses([
      context => {
        trace.push('provider:first');
        expect(getCurrentSystemPrompt(context.messages)).toContain('Pinned OS policy.');
        expect(getCurrentSystemPrompt(context.messages)).toContain('Canonical package context is active.');
        expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual([toolName]);
        return fauxAssistantMessage(fauxToolCall(toolName, { text: 'first pass' }, { id: 'canonical-package-call' }), { stopReason: 'toolUse' });
      },
      async context => {
        trace.push('provider:after-commit');
        const persisted = await state.storage.get<PersistedStep>('canonical-package-step');
        expect(persisted?.toolCalls).toMatchObject([{ toolName, output: 'Canonical package result: first pass', pluginResourceId: resource.id }]);
        expect(context.messages.find(message => message.role === 'toolResult')).toMatchObject({
          toolName, isError: false, details: { output: 'Canonical package result: first pass', pluginResourceId: resource.id },
        });
        return fauxAssistantMessage(fauxText('Package completed.'));
      },
    ]);
    await runOpenCodeLoop({ storage: state.storage, chatId: 1, resources: [resource], loadResource: async () => resource,
      packagePluginPrompt: packagePlugins.prompt, maxTokens: 1024, signal: new AbortController().signal,
      context: { messages: initial, tools: packagePlugins.tools }, handle: { model: faux.getModel(), stream: faux.stream },
      finishTurn: () => undefined,
      async emit(event) {
        if (event.type === 'tool_execution_end') {
          trace.push('tool:end');
          expect(event).toMatchObject({ toolName, isError: false,
            result: { details: { output: 'Canonical package result: first pass', pluginResourceId: resource.id } } });
        }
        if (event.type !== 'turn_end' || event.toolResults.length === 0) return;
        if (event.message.role !== 'assistant') throw new Error('Expected a canonical assistant message');
        const block = event.message.content.find(part => part.type === 'toolCall');
        if (!block || block.type !== 'toolCall') throw new Error('Expected the package call');
        const result = event.toolResults[0];
        const details = z.object({ output: z.string(), pluginResourceId: z.string() }).strict().parse(result.details);
        const call: AiToolCall = { toolCallId: block.id, toolName, input: block.arguments, ...details };
        await state.storage.put('canonical-package-step', { assistant: makeStoredAssistantMessage(event.message),
          toolCalls: [call], results: event.toolResults } satisfies PersistedStep);
        trace.push('commit');
      },
    });
    expect(trace).toEqual(['provider:first', 'tool:end', 'commit', 'provider:after-commit']);

    const persisted = await state.storage.get<PersistedStep>('canonical-package-step');
    if (!persisted) throw new Error('Canonical package step was not persisted');
    const assistant = rehydrateStoredAssistantMessage(persisted.assistant, persisted.toolCalls, 1, 1);
    if (!assistant) throw new Error('Canonical package snapshot could not be rehydrated');
    const replay = createFauxCore({ models: [{ id: 'faux-model' }] });
    replay.setResponses([context => {
      expect(context.messages.find(message => message.role === 'toolResult')).toMatchObject({ toolName,
        content: [{ type: 'text', text: 'Canonical package result: first pass' }], details: { pluginResourceId: resource.id } });
      expect(context.messages.find(message => message.role === 'assistant')).toMatchObject({
        content: [{ type: 'toolCall', id: 'canonical-package-call', name: toolName, arguments: { text: 'first pass' } }],
      });
      return fauxAssistantMessage(fauxText('Replayed without executing the package again.'));
    }]);
    await runOpenCodeLoop({ storage: state.storage, chatId: 1, resources: [resource], packagePluginPrompt: packagePlugins.prompt,
      maxTokens: 1024, signal: new AbortController().signal, handle: { model: replay.getModel(), stream: replay.stream },
      context: { messages: [...initial, assistant, ...persisted.results], tools: [] }, finishTurn: () => undefined, async emit() {},
    });
    expect(await state.storage.get('os:opencode-loop:owned:1')).toBeUndefined();
    expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'os_native_%'").toArray()).toEqual([]);
  });
});
