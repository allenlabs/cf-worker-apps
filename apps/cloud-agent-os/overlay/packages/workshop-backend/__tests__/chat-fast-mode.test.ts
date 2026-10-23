import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AiChatMetadata, AiChatMessage, AiChatAuthorInfo } from '@gadgets/workshop-shared/api';
import type { OverseerDurableObject } from '../src/overseer';
import type { UserDurableObject, UserChatContext } from '../src/user';
import type { ActiveAgentRecord, OverseerStorage } from '../src/storage-schema/overseer-storage';
import { makeUserStorage, type UserAiModelRecord } from '../src/storage-schema/user-storage';
import { openFakeOverseer } from './fixtures';

const author: AiChatAuthorInfo = { type: 'user', id: 'fast-chat@example.invalid', name: 'Synthetic user' };
const supported: UserAiModelRecord = { profile: { type: 'agent', id: 'gpt-6.1-sol', name: 'Synthetic model', supportsFast: true },
  config: { provider: 'openai', model: 'gpt-6.1-sol', apiToken: '', transport: 'subscription',
    subscriptionProvider: 'siwc', subscriptionAccountId: 'owner' } };
interface ChatImpl {
  storage: OverseerStorage;
  env: Cloudflare.Env;
  constructor: new (state: DurableObjectState, env: Cloudflare.Env) => ChatImpl;
  newChat(user: DurableObjectStub<UserDurableObject>, context: UserChatContext, message: string,
    capsules?: undefined, attachments?: undefined, registration?: undefined, externalKey?: undefined,
    formats?: undefined, fastMode?: boolean): Promise<number>;
  sendChatMessage(user: DurableObjectStub<UserDurableObject>, context: UserChatContext, chatId: number,
    message: string, capsules?: undefined, attachments?: undefined, registration?: undefined,
    formats?: undefined, fastMode?: boolean): Promise<void>;
  startAgent(chatId: number, model: UserAiModelRecord, initiator: AiChatAuthorInfo, initiatorId: string,
    callback?: boolean, keepAlive?: boolean, fastMode?: boolean): void;
  reconcilePendingGadgets(chatId: number): Promise<void>;
  nextChatSequence(chatId: number): number;
  waitForAllAgentsToComplete(): Promise<void>;
}
let serial = 0;
async function withChat(action: (impl: ChatImpl, state: DurableObjectState,
  user: DurableObjectStub<UserDurableObject>) => Promise<void>) {
  const user = env.TEST_USER.getByName(`fast-chat-user-${++serial}`);
  await runInDurableObject(user, async instance => {
    await instance.loginOrCreateViaGatekeeper(author.id, true);
    await instance.addModel({ type: 'agent', id: 'personal', name: 'Personal' },
      { provider: 'openai', model: 'gpt-6.1-sol', apiToken: '' });
  });
  await runInDurableObject(env.TEST_OVERSEER.getByName(`fast-chat-${serial}`), async (instance: OverseerDurableObject, state) => {
    await action(Reflect.get(instance, 'impl') as ChatImpl, state, user);
  });
}
function context(aiModel: UserAiModelRecord | undefined = supported): UserChatContext { return { profile: author, aiModel }; }
function seed(impl: ChatImpl, id = 1): AiChatMetadata {
  const metadata = { id, title: 'Synthetic chat', started: new Date(0), lastActive: new Date(0) };
  impl.storage.chatMeta.put(metadata);
  return metadata;
}

describe('per-chat Fast acceptance and durable turn snapshot', () => {
  it('strips forged Fast capability from personal model writes and historical reads', async () => {
    await runInDurableObject(env.TEST_USER.getByName(`fast-personal-${++serial}`), async (user, state) => {
      const profile = { type: 'agent' as const, id: 'personal', name: 'Personal', supportsFast: true };
      const config = { provider: 'openai' as const, model: 'gpt-6.1-sol', apiToken: '' };
      await user.addModel(profile, config);
      expect(makeUserStorage(state.storage).aiModels.get('personal')?.profile).not.toHaveProperty('supportsFast');
      await user.updateModel(profile, config);
      expect(makeUserStorage(state.storage).aiModels.get('personal')?.profile).not.toHaveProperty('supportsFast');
      makeUserStorage(state.storage).aiModels.put({ profile, config });
      expect((await user.listModels())[0]).not.toHaveProperty('supportsFast');
      expect((await user.getModelConfig('personal')).profile).not.toHaveProperty('supportsFast');
      expect((await user.getChatContext('personal')).aiModel?.profile).not.toHaveProperty('supportsFast');
    });
  });

  it('rejects unsupported Fast before creating a chat or committing a user message', () => withChat(async (impl, _state, user) => {
    const original = impl.startAgent;
    impl.startAgent = () => {};
    try {
      for (const aiModel of [undefined, { ...supported, profile: { ...supported.profile, supportsFast: undefined } },
        { ...supported, config: { ...supported.config, subscriptionProvider: 'codex' as const } },
        { ...supported, config: { provider: 'openai' as const, model: 'gpt-6.1-sol', apiToken: '' } }]) {
        await expect(impl.newChat(user, { profile: author, aiModel }, 'Rejected', undefined, undefined, undefined,
          undefined, undefined, true)).rejects.toThrow(/Fast.*not available/);
      }
      expect([...impl.storage.chatMeta.list()]).toEqual([]);
      expect([...impl.storage.chats.list()]).toEqual([]);
      const before = seed(impl);
      await expect(impl.sendChatMessage(user, context({ ...supported, profile: { ...supported.profile, supportsFast: false } }),
        before.id, 'Rejected', undefined, undefined, undefined, undefined, true)).rejects.toThrow(/Fast.*not available/);
      expect(impl.storage.chatMeta.get(before.id)).toEqual(before);
      expect([...impl.storage.chats.list()]).toEqual([]);
    } finally { impl.startAgent = original; }
  }));

  it('saves normalized Fast only with accepted messages and passes the captured preference to the new turn', () => withChat(async (impl, _state, user) => {
    const started: (boolean | undefined)[] = [];
    const original = impl.startAgent;
    impl.startAgent = (_chat, _model, _author, _user, _callback, _keepAlive, fastMode) => { started.push(fastMode); };
    try {
      const chatId = await impl.newChat(user, context(), 'Fast request', undefined, undefined, undefined,
        undefined, undefined, true);
      expect(impl.storage.chatMeta.get(chatId)?.fastMode).toBe(true);
      const metadata = impl.storage.chatMeta.get(chatId)!;
      delete metadata.activeAgent;
      impl.storage.chatMeta.put(metadata);
      await impl.sendChatMessage(user, context(), chatId, 'Default request');
      expect(impl.storage.chatMeta.get(chatId)?.fastMode).toBe(false);
      expect(started).toEqual([true, false]);
      const messages = [...impl.storage.chats.list()] as AiChatMessage[];
      expect(messages.filter(message => message.type === 'message').map(message => message.message))
        .toEqual(['Fast request', 'Default request']);
    } finally { impl.startAgent = original; }
  }));

  it('validates and persists Fast in authenticated retries before changing the chat', () => withChat(async impl => {
    const metadata = seed(impl);
    let selected = supported;
    const calls: unknown[][] = [];
    const startArguments: unknown[][] = [];
    const delegates = Object.fromEntries(['assertChatNotActive', 'materializeChatChanges', 'getChatTimestamp']
      .map(method => [method, Reflect.get(impl, method).bind(impl)]));
    using client = await openFakeOverseer(impl.storage, { impl: {
      ...delegates, logger: Reflect.get(impl, 'logger'),
      users: { idFromString: (id: string) => id, get: () => ({ id: { toString: () => 'synthetic-user' },
        whoami: async () => author,
        getChatContext: async (...args: unknown[]) => { calls.push(args); return context(selected); },
      }) },
      startAgent: (...args: unknown[]) => { startArguments.push(args); },
    } });
    selected = { ...supported, profile: { ...supported.profile, supportsFast: false } };
    await expect(client.retryAgent(metadata.id, supported.profile.id, true)).rejects.toThrow(/Fast.*not available/);
    expect(impl.storage.chatMeta.get(metadata.id)).toEqual(metadata);
    expect(startArguments).toEqual([]);
    selected = supported;
    await client.retryAgent(metadata.id, supported.profile.id, true);
    expect(impl.storage.chatMeta.get(metadata.id)?.fastMode).toBe(true);
    expect(startArguments[0].at(-1)).toBe(true);
    const active = impl.storage.chatMeta.get(metadata.id)!;
    delete active.activeAgent;
    impl.storage.chatMeta.put(active);
    await client.retryAgent(metadata.id, supported.profile.id);
    expect(impl.storage.chatMeta.get(metadata.id)?.fastMode).toBe(false);
    expect(startArguments[1].at(-1)).toBe(false);
    expect(calls).toEqual([[supported.profile.id, true], [supported.profile.id, true], [supported.profile.id, undefined]]);
  }));

  it('persists a turn snapshot independently from later chat preference edits', () => withChat(async (impl, _state, user) => {
    const metadata = seed(impl);
    metadata.activeAgent = supported.profile;
    metadata.fastMode = true;
    impl.storage.chatMeta.put(metadata);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = impl.reconcilePendingGadgets;
    impl.reconcilePendingGadgets = async () => { await held; };
    impl.startAgent(metadata.id, supported, author, user.id.toString(), false, false, true);
    try {
      expect(impl.storage.activeAgents.get(metadata.id)?.fastMode).toBe(true);
      metadata.fastMode = false;
      impl.storage.chatMeta.put(metadata);
      expect(impl.storage.activeAgents.get(metadata.id)?.fastMode).toBe(true);
    } finally {
      release();
      await impl.waitForAllAgentsToComplete();
      impl.reconcilePendingGadgets = original;
    }
    expect(impl.storage.activeAgents.get(metadata.id)).toBeUndefined();
  }));

  it('refuses lost Fast support on restart using the active snapshot and clears active state', () => withChat(async (impl, state, user) => {
    const metadata = seed(impl);
    metadata.activeAgent = { ...supported.profile, id: 'personal' };
    metadata.fastMode = false;
    impl.storage.chatMeta.put(metadata);
    impl.storage.activeAgents.put({ chatId: metadata.id, initiatorUserId: user.id.toString(), modelId: 'personal',
      initiator: author, callbackInitiated: false, fastMode: true } as ActiveAgentRecord);
    const resumed = new impl.constructor(state, impl.env);
    await resumed.waitForAllAgentsToComplete();
    expect(resumed.storage.activeAgents.get(metadata.id)).toBeUndefined();
    expect(resumed.storage.chatMeta.get(metadata.id)?.activeAgent).toBeUndefined();
    expect([...resumed.storage.chats.list()]).toContainEqual(expect.objectContaining({
      type: 'error', message: expect.stringMatching(/Fast.*no longer available/),
    }));
  }));

  it('routes resumed turns from the stored snapshot and treats legacy records as default', async () => {
    for (const snapshot of [true, undefined]) await withChat(async (impl, state, user) => {
      const metadata = seed(impl);
      metadata.activeAgent = supported.profile;
      metadata.fastMode = snapshot !== true;
      impl.storage.chatMeta.put(metadata);
      impl.storage.chats.put({ chatId: metadata.id, sequence: impl.nextChatSequence(metadata.id), timestamp: new Date(0),
        author, type: 'message', message: 'Synthetic resume request' });
      impl.storage.activeAgents.put({ chatId: metadata.id, initiatorUserId: user.id.toString(),
        modelId: supported.profile.id, initiator: author, callbackInitiated: false,
        ...(snapshot === undefined ? {} : { fastMode: snapshot }) });
      const resolutions: unknown[][] = [], requests: { options: { serviceTier?: string } }[] = [];
      const namespace = { idFromString: (id: string) => id, get: () => ({
        getChatContext: async (...args: unknown[]) => { resolutions.push(args); return context(); },
      }) };
      const exports = new Proxy(state.exports, { get(target, key) {
        return key === 'UserDurableObject' ? namespace : Reflect.get(target, key, target);
      } });
      const resumedState = new Proxy(state, { get(target, key) {
        if (key === 'exports') return exports;
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const deployment = { ...impl.env, CODEX_BRIDGE_MANAGEMENT: 'admin', CODEX_BRIDGE_MODEL: supported.config.model,
        CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([author.id]), CODEX_BRIDGE: {
          async infer(request: { options: { serviceTier?: string } }) {
            requests.push(request);
            const message = { role: 'assistant', content: [], api: 'openai-responses', provider: 'openai',
              model: supported.config.model, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
                totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'error', errorMessage: 'inference_bridge_provider_error', timestamp: 0 };
            return { stream: new ReadableStream<Uint8Array>({ start(controller) {
              controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: 1,
                event: { type: 'error', reason: 'error', error: message } }) + '\n'));
              controller.close();
            } }), cancellation: { async cancel() {}, [Symbol.dispose]() {} } };
          },
        } } as unknown as Cloudflare.Env;
      const resumed = new impl.constructor(resumedState, deployment);
      await resumed.waitForAllAgentsToComplete();
      expect(resolutions).toEqual([[supported.profile.id, snapshot]]);
      expect(requests).toHaveLength(1);
      expect(requests[0].options.serviceTier).toBe(snapshot ? 'priority' : undefined);
      expect(resumed.storage.activeAgents.get(metadata.id)).toBeUndefined();
    });
  });
});
