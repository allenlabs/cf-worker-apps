import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, Type } from '@earendil-works/pi-ai';
import type { Message } from '@earendil-works/pi-ai';
import type { AgentResource } from '@gadgets/workshop-shared/api';
import { describe, expect, it } from 'vitest';
import { runOpenCodeLoop } from '../src/opencode-loop';
import { scopedResourcePrompt } from '../src/scoped-agent-resources';
import './test-worker';

let count = 0;
const skill = { id: 'skill-review', name: 'Review guide', scope: { kind: 'team', teamId: 'engineering' }, enabled: true,
  kind: 'skill', description: 'Review the proposed change', content: 'Old skill body, do not preload.' } satisfies AgentResource;
const initial: Message[] = [{ role: 'system', content: 'Pinned OS instructions', timestamp: 0 },
  { role: 'user', content: 'Use the configured resources', timestamp: 0 }];

describe('scoped resources in the real native OpenCode loop', () => {
  it('delivers bundled plugin instructions and catalog to the provider, then loads the latest skill body', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`scoped-native-${++count}`), async instance => {
      const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
      const resources: AgentResource[] = [skill,
        { id: 'org-instructions', name: 'Organization instructions', scope: { kind: 'organization' }, enabled: true,
          kind: 'plugin', pluginId: 'instructions', instructions: 'Always describe the validation result.' },
        { id: 'personal-mcp', name: 'Personal MCP', scope: { kind: 'personal', userId: 'synthetic-user' }, enabled: true,
          kind: 'mcp', endpoint: 'https://mcp.example/api', description: 'Synthetic MCP endpoint' },
        { ...skill, id: 'disabled-skill', enabled: false, name: 'Disabled private resource' },
      ];
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      let reads = 0;
      faux.setResponses([
        context => {
          const prompt = getCurrentSystemPrompt(context.messages);
          expect(prompt).toContain('Pinned OS instructions');
          expect(prompt.match(/Always describe the validation result\./g)).toHaveLength(1);
          expect(prompt).toContain('team:engineering');
          expect(prompt).toContain('Review the proposed change');
          expect(prompt).toContain('https://mcp.example/api');
          expect(prompt).toContain('vendorId "mcp"');
          expect(prompt).toContain('Each user must connect independently');
          expect(prompt).not.toContain('Disabled private resource');
          expect(prompt).not.toContain('Revoked resource prompt');
          expect(prompt).not.toContain(skill.content);
          expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(['loadSkill']);
          return fauxAssistantMessage(fauxToolCall('loadSkill', { id: skill.id }, { id: 'skill-load' }), { stopReason: 'toolUse' });
        },
        context => {
          expect(context.messages.find(message => message.role === 'toolResult')).toMatchObject({
            toolName: 'loadSkill', isError: false, details: { resourceId: skill.id },
            content: [{ type: 'text', text: expect.stringContaining('Current authorized Markdown') }],
          });
          return fauxAssistantMessage(fauxText('Reviewed'));
        },
      ]);
      await runOpenCodeLoop({ storage, chatId: 1, resources, maxTokens: 1024, signal: new AbortController().signal,
        handle: { model: faux.getModel(), stream: faux.stream },
        context: { messages: [{ role: 'system', content: 'Pinned OS instructions',
          sections: { agentResources: scopedResourcePrompt(resources) }, timestamp: 0 },
          { role: 'system', content: '', sections: { agentResources: 'Revoked resource prompt' }, timestamp: 0 }, initial[1]], tools: [] },
        async loadResource(id) { expect(id).toBe(skill.id); reads++; return { ...skill, content: '# Current authorized Markdown' }; },
        finishTurn: () => undefined, async emit() {},
      });
      expect(reads).toBe(1);
      expect(await storage.get('os:opencode-loop:owned:1')).toBeUndefined();
      expect(storage.sql.exec("SELECT name FROM sqlite_master WHERE name LIKE 'os_native_%'").toArray()).toEqual([]);
    });
  });

  it('rechecks current skill access after team membership revocation rather than serving cached content', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`scoped-native-${++count}`), async instance => {
      const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      let allowed = true;
      let reads = 0;
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('loadSkill', { id: skill.id }, { id: 'before-revoke' }), { stopReason: 'toolUse' }),
        context => {
          expect(context.messages.find(message => message.role === 'toolResult')).toMatchObject({ isError: false });
          allowed = false;
          return fauxAssistantMessage(fauxToolCall('loadSkill', { id: skill.id }, { id: 'after-revoke' }), { stopReason: 'toolUse' });
        },
        context => {
          const result = context.messages.find(message => message.role === 'toolResult' && message.toolCallId === 'after-revoke');
          expect(result).toMatchObject({ isError: true, content: [{ type: 'text', text: 'Skill unavailable or access revoked' }] });
          expect(JSON.stringify(result)).not.toContain(skill.content);
          return fauxAssistantMessage(fauxText('Access revoked'));
        },
      ]);
      await runOpenCodeLoop({ storage, chatId: 1, resources: [skill], maxTokens: 1024, signal: new AbortController().signal,
        handle: { model: faux.getModel(), stream: faux.stream }, context: { messages: initial, tools: [] },
        async loadResource() { reads++; return allowed ? skill : undefined; }, finishTurn: () => undefined, async emit() {},
      });
      expect(reads).toBe(2);
    });
  });

  it('unions restrictions across scopes and rejects provider-emitted denied calls without executing them', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`scoped-native-${++count}`), async instance => {
      const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      const executed: string[] = [];
      const resources: AgentResource[] = [
        { id: 'org-policy', name: 'Organization policy', scope: { kind: 'organization' }, enabled: true,
          kind: 'plugin', pluginId: 'tool-policy', deniedTools: ['mutate'] },
        { id: 'team-policy', name: 'Team policy', scope: { kind: 'team', teamId: 'nested-team' }, enabled: true,
          kind: 'plugin', pluginId: 'tool-policy', deniedTools: ['requestConnection'] },
        { id: 'personal-policy', name: 'Personal policy', scope: { kind: 'personal', userId: 'synthetic-user' }, enabled: true,
          kind: 'plugin', pluginId: 'tool-policy', deniedTools: [] },
      ];
      faux.setResponses([
        context => {
          expect(getCurrentTools(context.messages).map(tool => tool.name)).toEqual(['read']);
          expect(JSON.stringify(context.messages)).not.toContain('Forbidden declaration');
          return fauxAssistantMessage([
            fauxToolCall('mutate', {}, { id: 'org-denied' }),
            fauxToolCall('requestConnection', {}, { id: 'team-denied' }),
            fauxToolCall('execute', { code: 'return "bypass";' }, { id: 'native-denied' }),
            fauxToolCall('read', {}, { id: 'allowed' }),
          ], { stopReason: 'toolUse' });
        },
        context => {
          const results = context.messages.filter(message => message.role === 'toolResult');
          expect(results.map(result => [result.toolCallId, result.isError])).toEqual([
            ['org-denied', true], ['team-denied', true], ['native-denied', true], ['allowed', false],
          ]);
          return fauxAssistantMessage(fauxText('Only the permitted read executed'));
        },
      ]);
      await runOpenCodeLoop({ storage, chatId: 1, resources, maxTokens: 1024, signal: new AbortController().signal,
        handle: { model: faux.getModel(), stream: faux.stream },
        context: { messages: [{ role: 'system', content: 'OS instructions', timestamp: 0,
          toolsAdded: ['mutate', 'requestConnection', 'execute'].map(name => ({ name, description: 'Forbidden declaration', parameters: Type.Object({}) })) }, initial[1]],
          tools: ['mutate', 'requestConnection', 'execute', 'read'].map(name => ({ name, label: name, description: name,
            parameters: Type.Object({}), async execute() { executed.push(name); return { content: [{ type: 'text', text: name }] }; } })) },
        finishTurn: () => undefined, async emit() {},
      });
      expect(executed).toEqual(['read']);
      expect(await storage.get('os:opencode-loop:owned:1')).toBeUndefined();
    });
  });

  it('validates skill arguments and catalog identity before invoking the current access check', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`scoped-native-${++count}`), async instance => {
      const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      let reads = 0;
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall('loadSkill', { id: 123 }, { id: 'malformed' }),
          fauxToolCall('loadSkill', { id: 'not-in-catalog' }, { id: 'unknown' }),
          fauxToolCall('loadSkill', { id: skill.id }, { id: 'valid' }),
        ], { stopReason: 'toolUse' }),
        context => {
          expect(context.messages.filter(message => message.role === 'toolResult').map(message => message.isError)).toEqual([true, true, false]);
          return fauxAssistantMessage(fauxText('Loaded the permitted skill'));
        },
      ]);
      await runOpenCodeLoop({ storage, chatId: 1, resources: [skill], maxTokens: 1024, signal: new AbortController().signal,
        handle: { model: faux.getModel(), stream: faux.stream }, context: { messages: initial, tools: [] },
        async loadResource() { reads++; return skill; }, finishTurn: () => undefined, async emit() {},
      });
      expect(reads).toBe(1);
    });
  });
});

it('bounds the rendered resource prompt before starting native state', () => {
  expect(() => scopedResourcePrompt([{ ...skill, description: '한'.repeat(40_001) }])).toThrow('exceed the context limit');
});
