import { env, RpcStub } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createFauxCore, fauxAssistantMessage, fauxText, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { describe, expect, it, vi } from 'vitest';
import type { AiChatAuthorInfo, AgentResource, AgentSettingsCommand } from '@gadgets/workshop-shared/api';
import type { Gatekeeper } from '@gadgets/workshop-shared/gatekeeper';
import { AdminSettings } from '../src/admin-settings';
import { getModel, LanguageModelGatekeeper } from '../src/ai-models';
import type { LanguageModelBinding } from '../src/ai-model-binding';
import { runAgent, type AgentHooks } from '../src/agent';
import { scopedModelId, scopedModelResolver } from '../src/scoped-models';
import type { OverseerDurableObject } from '../src/overseer';
import type { OverseerStorage } from '../src/storage-schema/overseer-storage';
import './test-worker';

type TestImpl = AgentHooks & {
  ownerId?: string;
  storage: OverseerStorage;
  ensureAmbientCapsules(): Promise<void>;
  markOutputsDirty(): void;
  gadgetAuthorFor(profile: AiChatAuthorInfo): AiChatAuthorInfo;
  scopedModelResolverFor(author: AiChatAuthorInfo): ReturnType<typeof scopedModelResolver> | undefined;
  getGatekeeperFacet(id: number): Promise<Gatekeeper<LanguageModelBinding>>;
  nextChatSequence(chatId: number): number;
};
function implFor(instance: OverseerDurableObject): TestImpl {
  return (instance as unknown as { impl: TestImpl }).impl;
}
const administrator = 'principal-admin@example.invalid', userId = 'principal-owner@example.invalid';
const provider = { id: 'principal-provider', kind: 'provider', name: 'Private team router',
  scope: { kind: 'team', teamId: 'principal-team' }, enabled: true,
  baseUrl: 'https://principal-models.example.com/v1' } satisfies AgentResource;
const plugin = { id: 'principal-instructions', kind: 'plugin', name: 'Private instructions',
  scope: provider.scope, enabled: true, pluginId: 'instructions',
  instructions: 'Synthetic private team instructions.' } satisfies AgentResource;
type Change = AgentSettingsCommand extends infer Command
  ? Command extends AgentSettingsCommand ? Omit<Command, 'expectedRevision'> : never : never;
async function update(command: Change) {
  await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(''), async (_host, state) => {
    const admin = new AdminSettings(state, { ...env, ADMINS: [administrator] });
    const current = await admin.getAgentSettings(administrator);
    await admin.updateAgentSettings(administrator, { ...command, expectedRevision: current.revision });
  });
}
async function seed() {
  await update({ type: 'saveTeam', team: { id: provider.scope.teamId, name: 'Synthetic team', parentId: null } });
  await update({ type: 'saveMembership', membership: { teamId: provider.scope.teamId, userId, role: 'member' } });
  await update({ type: 'saveResource', resource: provider, apiToken: 'synthetic-provider-key' });
  await update({ type: 'saveResource', resource: plugin });
  const user = env.TEST_USER.getByName(userId);
  await runInDurableObject(user, async account => { await account.loginOrCreateViaGatekeeper(userId, true); });
  return user;
}
function syntheticModelTransport(apiToken = 'synthetic-provider-key') {
  const requests: Request[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    expect(new URL(request.url).origin).toBe(new URL(provider.baseUrl).origin);
    expect(request.headers.get('authorization')).toBe(apiToken ? `Bearer ${apiToken}` : null);
    if (new URL(request.url).pathname === '/v1/models') return Response.json({ data: [{ id: 'synthetic-physical-model' }] });
    expect(new URL(request.url).pathname).toBe('/v1/chat/completions');
    expect(await request.json()).toMatchObject({ model: 'synthetic-physical-model' });
    const chunks = [
      { id: 'synthetic-completion', choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic OK' }, finish_reason: null }] },
      { id: 'synthetic-completion', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ];
    return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  });
  return requests;
}

describe('trusted account principal behind gadget authors', () => {
  it('binds through the owner client and revokes existing bindings and callback resources with current team authority', async () => {
    const user = await seed(), requests = syntheticModelTransport();
    const ownerId = user.id.toString(), logicalId = scopedModelId(provider.id, 'synthetic-physical-model');
    const workspace = env.TEST_OVERSEER.getByName('principal-binding');
    try {
      const saved = await runInDurableObject(workspace, async instance => {
        const impl = implFor(instance);
        impl.ownerId = ownerId;
        impl.ensureAmbientCapsules = async () => {};
        impl.markOutputsDirty = () => {};
        const client = await instance.open(ownerId, userId, new RpcStub<() => void>(() => {}));
        try {
          const connection = await client.newAiModelGatekeeper(logicalId);
          const binding = await connection.openSession();
          expect(await binding.run({ prompt: 'Synthetic binding call' })).toBe('Synthetic OK');
          const callbackAuthor = impl.gadgetAuthorFor(await env.TEST_USER.getByName(userId).whoami());
          expect(callbackAuthor).toMatchObject({ type: 'gadget', id: userId });
          expect((await impl.getAgentResources(callbackAuthor)).map(resource => resource.id))
            .toEqual(expect.arrayContaining([provider.id, plugin.id]));
          expect(await impl.scopedModelResolverFor(callbackAuthor)!(logicalId))
            .toMatchObject({ providerId: provider.id, modelId: 'synthetic-physical-model' });
          const modelAuthor: AiChatAuthorInfo = { type: 'agent', id: userId, name: 'Untrusted model display' };
          expect(impl.scopedModelResolverFor(modelAuthor)).toBeUndefined();
          expect(await impl.getAgentResources(modelAuthor)).toEqual([]);
          expect(() => impl.gadgetAuthorFor(modelAuthor)).toThrow('verified account');
          const current = await env.TEST_USER.getByName(userId).getChatContext(logicalId);
          return { connectionId: await connection.getId(), props: {
            displayName: current.aiModel!.profile.name, config: current.aiModel!.config, initiator: callbackAuthor,
          } };
        } finally { client[Symbol.dispose](); }
      });
      const before = requests.length;
      await update({ type: 'removeMembership', teamId: provider.scope.teamId, userId });
      await runInDurableObject(workspace, async instance => {
        const impl = implFor(instance);
        const callbackAuthor = impl.gadgetAuthorFor(await env.TEST_USER.getByName(userId).whoami());
        expect(await impl.getAgentResources(callbackAuthor)).toEqual([]);
        await expect(impl.scopedModelResolverFor(callbackAuthor)!(logicalId)).rejects.toThrow('no longer available');
        expect((await (await impl.getGatekeeperFacet(saved.connectionId)).describe()).title).toBe(saved.props.displayName);
      });
      // The pool flags rejected native facet RPCs as unhandled, so exercise the same binding
      // implementation locally in Workerd for the expected denial, using the saved verified config.
      await runInDurableObject(env.TEST_USER_DIRECTORY.getByName('principal-revoked-binding'), async (_host, state) => {
        Object.defineProperty(state, 'props', { configurable: true, value: saved.props });
        const binding = await new LanguageModelGatekeeper(state, env).startSession(undefined!);
        await expect(binding.run({ prompt: 'Revoked binding call' })).rejects.toThrow('permissions');
      });
      expect(requests).toHaveLength(before);
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects observer sharing for scoped bindings without trusting an audience claim', async () => {
    await runInDurableObject(env.TEST_USER_DIRECTORY.getByName('principal-observer'), async (_host, state) => {
      Object.defineProperty(state, 'props', { configurable: true, value: {
        displayName: 'Scoped model', initiator: { type: 'gadget', id: userId, name: 'Workspace' },
        config: { provider: 'openai', model: 'synthetic-physical-model', apiToken: '',
          transport: 'scoped', scopedProviderId: provider.id },
      } });
      await expect(new LanguageModelGatekeeper(state, env).addObserver('unverified-observer', undefined!))
        .rejects.toThrow('cannot be shared');
    });
  });
  it('uses the actual scoped inference stack for a keyless provider without borrowing ambient credentials', async () => {
    await seed();
    await update({ type: 'saveResource', resource: provider, apiToken: '' });
    const requests = syntheticModelTransport('');
    try {
      await runInDurableObject(env.TEST_OVERSEER.getByName('principal-keyless'), async instance => {
        const impl = implFor(instance);
        const author = impl.gadgetAuthorFor(await env.TEST_USER.getByName(userId).whoami());
        const handle = getModel({ ...env, CF_AI_GATEWAY_API_TOKEN: 'synthetic-ambient-token' },
          { provider: 'openai', model: 'synthetic-physical-model', apiToken: '', transport: 'scoped', scopedProviderId: provider.id },
          author, { resolveScopedModel: impl.scopedModelResolverFor(author),
            userGateway: { accountId: 'synthetic-account', apiKey: 'synthetic-other-token' } });
        const result = await handle.stream(handle.model,
          { messages: [{ role: 'user', content: 'Synthetic keyless call', timestamp: 0 }] }, { maxRetries: 0 }).result();
        expect(result.stopReason).toBe('stop');
        expect(result.content).toEqual([{ type: 'text', text: 'Synthetic OK' }]);
        expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/v1/models', '/v1/chat/completions']);
        expect(requests.every(request => !request.headers.has('authorization') && !request.headers.has('cf-aig-authorization'))).toBe(true);
      });
    } finally { vi.unstubAllGlobals(); }
  });
  it('requires a server-supplied scoped resolver instead of trusting the author display type', () => {
    for (const type of ['user', 'gadget', 'agent'] as const) {
      expect(() => getModel(env, { provider: 'openai', model: 'synthetic-physical-model', apiToken: '',
        transport: 'scoped', scopedProviderId: provider.id }, { type, id: userId, name: 'Display' }))
        .toThrow('Scoped provider access is unavailable');
    }
  });
  it('places the workspace cache salt before private resource instructions in the actual agent request', async () => {
    await seed();
    await runInDurableObject(env.TEST_OVERSEER.getByName('principal-private-prompt'), async instance => {
      const impl = implFor(instance);
      const callbackAuthor = impl.gadgetAuthorFor(await env.TEST_USER.getByName(userId).whoami());
      const chatId = 1;
      impl.storage.chatMeta.put({ id: chatId, title: 'Synthetic', started: new Date(0), lastActive: new Date(0) });
      impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: new Date(0),
        author: callbackAuthor, type: 'message', message: 'Synthetic prompt check' });
      const faux = createFauxCore({ models: [{ id: 'synthetic-faux' }] });
      let checked = false;
      faux.setResponses([context => {
        const prompt = getCurrentSystemPrompt(context.messages);
        const saltIndex = prompt.indexOf(`Prompt cache salt (ignore): ${impl.getPromptCacheSalt()}`);
        expect(saltIndex).toBeGreaterThan(-1);
        expect(prompt.indexOf(plugin.instructions)).toBeGreaterThan(saltIndex);
        checked = true;
        return fauxAssistantMessage(fauxText('Synthetic done'));
      }]);
      await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, chatId,
        { type: 'agent', id: 'synthetic-faux', name: 'Faux' }, new AbortController().signal, callbackAuthor,
        { provider: 'cloudflare', model: 'synthetic-faux', apiToken: '' });
      expect(checked).toBe(true);
    });
  });
});
