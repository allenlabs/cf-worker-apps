import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createFauxCore, fauxAssistantMessage, fauxText, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import type { AgentResource, AiChatAuthorInfo, AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api';
import { expect, it } from 'vitest';
import { runAgent, type AgentHooks } from '../src/agent';
import { AGENT_PLUGIN_PREFIX, pluginDigest, pluginInstallationId } from '../src/agent-plugin-artifacts';
import type { OverseerDurableObject } from '../src/overseer';
import type { GadgetRecord } from '../src/storage-schema/overseer-storage';
import './test-worker';

interface OverseerInternals extends AgentHooks {
  storage: {
    gadgets: { put(record: GadgetRecord): void };
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void };
  };
  nextChatSequence(chatId: number): number;
}

const owner: AiChatAuthorInfo = { type: 'user', id: 'synthetic-budget-owner', name: 'Owner' };
const author: AiChatAuthorInfo = { type: 'agent', id: 'faux-model', name: 'Faux' };
const oldText = 'Earlier discussion. '.repeat(1000);
const hookText = 'Package context. '.repeat(900);
const module = `export default {id:'synthetic.budget',async setup(ctx){await ctx.session.hook('context',event=>event.system.push({type:'text',text:${JSON.stringify(hookText)}}));}};`;

it('budgets current package hooks before prompting even when prior measured usage was small', async () => {
  const resource = { id: 'synthetic-budget-package', name: 'Budget package', scope: { kind: 'organization' },
    enabled: true, kind: 'plugin', pluginId: 'package', execution: 'dynamic', options: '{}',
    source: { kind: 'bundle', digest: await pluginDigest(module) } } satisfies AgentResource;
  const artifact = JSON.stringify({ apiVersion: 1, source: resource.source, module, packageIntegrity: null, lockDigest: null });
  const digest = await pluginDigest(artifact), id = await pluginInstallationId(resource);
  await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}artifacts/${digest}.json`, artifact);
  await env.BLUEPRINT_CONTENT.put(`${AGENT_PLUGIN_PREFIX}results/${id}.json`, JSON.stringify({ apiVersion: 1, id,
    status: 'ready', artifactDigest: digest, error: null, updatedAt: new Date().toISOString() }));

  const run = async (name: string, resources: AgentResource[], budget: number) => {
    const events: string[] = [];
    let promptLength = 0;
    await runInDurableObject(env.TEST_OVERSEER.getByName(name), async (instance: OverseerDurableObject) => {
      const impl = (instance as unknown as { impl: OverseerInternals }).impl;
      impl.storage.gadgets.put({ type: 'gadget', id: 100, title: 'App', created: new Date(0), bindingName: 'APP', bindings: {} });
      impl.storage.chatMeta.put({ id: 1, title: 'Chat', started: new Date(0), lastActive: new Date(0) });
      for (const [messageAuthor, message] of [[owner, oldText], [author, 'Earlier answer.'], [owner, 'Continue.']] as const) {
        const sequence = impl.nextChatSequence(1);
        impl.storage.chats.put({ chatId: 1, sequence, timestamp: new Date(sequence),
          author: messageAuthor, type: 'message', message });
      }
      impl.getAgentResources = async () => resources;
      const loadHistory = impl.loadChatHistory.bind(impl);
      impl.loadChatHistory = chatId => ({ ...loadHistory(chatId), measuredTokens: 100 });
      impl.emitChatStreamEvent = (_chatId, event) => { if (event.type === 'compacting') events.push('compacting'); };
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      faux.setResponses([
        context => {
          promptLength = getCurrentSystemPrompt(context.messages).length;
          events.push('provider');
          return fauxAssistantMessage(fauxText('Earlier discussion summarized.'));
        },
        context => {
          expect(getCurrentSystemPrompt(context.messages)).toContain(hookText);
          events.push('provider:after-compaction');
          return fauxAssistantMessage(fauxText('Done.'));
        },
      ]);
      await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, 1, author,
        new AbortController().signal, owner, { provider: 'cloudflare', model: 'faux-model', apiToken: '', compactionInputBudget: budget });
    });
    return { events, promptLength };
  };
  const baseline = await run('package-budget-baseline', [], 90_000);
  expect(baseline.events).toEqual(['provider']);
  const budget = Math.ceil((baseline.promptLength / 4 + oldText.length / 4 + hookText.length / 8) / 0.85);
  const current = await run('package-budget-current', [resource], budget);
  expect(current.events).toEqual(['compacting', 'provider', 'provider:after-compaction']);
});
