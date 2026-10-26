import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createFauxCore, fauxAssistantMessage, fauxText, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import type { BotProfileSnapshot } from '@gadgets/workshop-shared/api';
import { runAgent } from '../src/agent';
import { openFakeOverseer } from './fixtures';
import './test-worker';

const owner = { type: 'user' as const, id: 'bot-chat-owner@example.invalid', name: 'Owner' };
const bot: BotProfileSnapshot = { id: '2a1b6428-6504-4b5b-b709-7df50164c960', revision: 7,
  name: 'Evidence partner', icon: 'search', instructions: 'Preserve exact identifiers. 한글 🌿  ', memory: 'connected' };
let serial = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('bot chat selection and replay', () => {
  for (const first of ['context', 'bot'] as const) {
    it(`starts both selected-bot reads before waiting and commits only after ${first} finishes first`, async () => {
      await runInDurableObject(env.TEST_OVERSEER.getByName(`bot-concurrent-${++serial}`), async instance => {
        const impl = (instance as any).impl;
        const context = deferred<{ profile: typeof owner }>();
        const selectedBot = deferred<BotProfileSnapshot>();
        const contextStarted = deferred<void>();
        let botReads = 0;
        const user = { id: { toString: () => 'synthetic-user' }, whoami: async () => owner,
          getChatContext: async (modelId: unknown, fastMode: unknown) => {
            expect([modelId, fastMode]).toEqual([null, undefined]);
            contextStarted.resolve();
            return context.promise;
          },
          getBotForChat: async (selection: unknown) => {
            expect(selection).toEqual({ id: bot.id, revision: bot.revision });
            botReads++;
            return selectedBot.promise;
          } };
        using client = await openFakeOverseer(impl.storage, { impl: {
          logger: impl.logger, newChat: impl.newChat.bind(impl),
          users: { idFromString: (id: string) => id, get: () => user },
        } });
        const creation = client.newChat('Concurrent task', null, undefined, undefined, undefined, undefined,
          { id: bot.id, revision: bot.revision });
        try {
          await contextStarted.promise;
          expect(botReads).toBe(1);
          if (first === 'context') context.resolve({ profile: owner });
          else selectedBot.resolve(structuredClone(bot));
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          expect([...impl.storage.chatMeta.list()]).toHaveLength(0);
          expect([...impl.storage.chats.list()]).toHaveLength(0);
          context.resolve({ profile: owner });
          selectedBot.resolve(structuredClone(bot));
          const id = await creation;
          expect(impl.storage.chatMeta.get(id).bot).toEqual(bot);
          expect([...impl.storage.chats.list()]).toMatchObject([{ message: 'Concurrent task', author: owner }]);
        } finally {
          context.resolve({ profile: owner });
          selectedBot.resolve(structuredClone(bot));
          await creation.catch(() => {});
        }
      });
    });
  }

  for (const failed of ['context', 'bot'] as const) {
    it(`creates no chat or message when the ${failed} lookup fails while the other read is pending`, async () => {
      await runInDurableObject(env.TEST_OVERSEER.getByName(`bot-read-failure-${++serial}`), async instance => {
        const impl = (instance as any).impl;
        const context = deferred<{ profile: typeof owner }>();
        const selectedBot = deferred<BotProfileSnapshot>();
        const contextStarted = deferred<void>();
        let botReads = 0;
        const user = { id: { toString: () => 'synthetic-user' }, whoami: async () => owner,
          getChatContext: async () => { contextStarted.resolve(); return context.promise; },
          getBotForChat: async () => { botReads++; return selectedBot.promise; } };
        using client = await openFakeOverseer(impl.storage, { impl: {
          logger: impl.logger, newChat: impl.newChat.bind(impl),
          users: { idFromString: (id: string) => id, get: () => user },
        } });
        const creation = client.newChat('Must not be stored', null, undefined, undefined, undefined, undefined,
          { id: bot.id, revision: bot.revision });
        // Observe rejection before deliberately failing a read.
        const outcome = creation.then(id => ({ id, error: undefined }),
          (error: unknown) => ({ id: undefined, error }));
        let settled = false;
        void outcome.then(() => { settled = true; });
        try {
          await contextStarted.promise;
          expect(botReads).toBe(1);
          const error = new Error(`${failed} lookup unavailable`);
          if (failed === 'context') context.reject(error);
          else selectedBot.reject(error);
          await new Promise<void>(resolve => setTimeout(resolve, 0));
          expect(settled).toBe(true);
          expect((await outcome).error).toMatchObject({ message: `${failed} lookup unavailable` });
          expect([...impl.storage.chatMeta.list()]).toHaveLength(0);
          expect([...impl.storage.chats.list()]).toHaveLength(0);
        } finally {
          context.resolve({ profile: owner });
          selectedBot.resolve(structuredClone(bot));
          await creation.catch(() => {});
        }
      });
    });
  }

  it('does not request a bot for a Standard assistant chat', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`bot-standard-${++serial}`), async instance => {
      const impl = (instance as any).impl;
      let botReads = 0;
      const user = { id: { toString: () => 'synthetic-user' }, whoami: async () => owner,
        getChatContext: async () => ({ profile: owner }),
        getBotForChat: async () => { botReads++; throw new Error('Standard assistant must not read a bot'); } };
      using client = await openFakeOverseer(impl.storage, { impl: {
        logger: impl.logger, newChat: impl.newChat.bind(impl),
        users: { idFromString: (id: string) => id, get: () => user },
      } });
      const id = await client.newChat('Standard task', null);
      expect(botReads).toBe(0);
      expect(impl.storage.chatMeta.get(id).bot).toBeUndefined();
      expect([...impl.storage.chats.list()]).toMatchObject([{ message: 'Standard task' }]);
    });
  });

  for (const reset of ['context', 'bot'] as const) {
    it(`retries a ${reset} reset once through a fresh user stub`, async () => {
      await runInDurableObject(env.TEST_OVERSEER.getByName(`bot-read-reset-${++serial}`), async instance => {
        const impl = (instance as any).impl;
        const contextStubs: number[] = [];
        const botStubs: number[] = [];
        let generation = 0;
        const get = () => {
          const stub = ++generation;
          return { id: { toString: () => 'synthetic-user' }, whoami: async () => owner,
            getChatContext: async () => {
              contextStubs.push(stub);
              if (reset === 'context' && contextStubs.length === 1) throw Object.assign(new Error('Synthetic DO reset'),
                { durableObjectReset: true, overloaded: true, remote: true });
              return { profile: owner };
            },
            getBotForChat: async () => {
              botStubs.push(stub);
              if (reset === 'bot' && botStubs.length === 1) throw Object.assign(new Error('Synthetic DO reset'),
                { durableObjectReset: true, overloaded: true, remote: true });
              return structuredClone(bot);
            } };
        };
        using client = await openFakeOverseer(impl.storage, { impl: {
          logger: impl.logger, newChat: impl.newChat.bind(impl),
          users: { idFromString: (id: string) => id, get },
        } });
        const id = await client.newChat('Reset recovery', null, undefined, undefined, undefined, undefined,
          { id: bot.id, revision: bot.revision });
        expect(contextStubs).toHaveLength(reset === 'context' ? 2 : 1);
        expect(botStubs).toHaveLength(reset === 'bot' ? 2 : 1);
        const retried = reset === 'context' ? contextStubs : botStubs;
        expect(retried[0]).not.toBe(retried[1]);
        expect(impl.storage.chatMeta.get(id).bot).toEqual(bot);
        expect([...impl.storage.chats.list()]).toMatchObject([{ message: 'Reset recovery' }]);
      });
    });
  }

  it('resolves the selected revision through the current user before committing a chat', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`bot-accept-${++serial}`), async instance => {
      const impl = (instance as any).impl;
      let available = true;
      const user = { id: { toString: () => 'synthetic-user' }, whoami: async () => owner,
        getChatContext: async () => ({ profile: owner }),
        getBotForChat: async (selected: unknown) => {
          expect(selected).toEqual({ id: bot.id, revision: bot.revision });
          if (!available) throw new Error('Bot unavailable to this user.');
          return structuredClone(bot);
        } };
      using client = await openFakeOverseer(impl.storage, { impl: {
        logger: impl.logger, newChat: impl.newChat.bind(impl),
        users: { idFromString: (id: string) => id, get: () => user },
      } });
      const id = await client.newChat('First task', null, undefined, undefined, undefined, undefined,
        { id: bot.id, revision: bot.revision });
      expect(impl.storage.chatMeta.get(id).bot).toEqual(bot);
      available = false;
      await expect(client.newChat('Unauthorized task', null, undefined, undefined, undefined, undefined,
        { id: bot.id, revision: bot.revision })).rejects.toThrow(/unavailable/);
      expect([...impl.storage.chatMeta.list()]).toHaveLength(1);
      expect([...impl.storage.chats.list()].map((message: any) => message.message)).toEqual(['First task']);
    });
  });

  it('replays only the stored role as user preferences, with no system-policy promotion', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`bot-prompt-${++serial}`), async (instance, state) => {
      const impl = (instance as any).impl;
      const chatId = 1;
      impl.storage.chatMeta.put({ id: chatId, title: 'Chat', started: new Date(0), lastActive: new Date(0), bot });
      impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: new Date(0),
        author: owner, type: 'message', message: 'Check the evidence.' });
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      const captured: any[] = [];
      faux.setResponses([(context: any) => { captured.push(context); return fauxAssistantMessage([fauxText('Done')]); }]);
      await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, chatId,
        { type: 'agent', id: 'faux-model', name: 'Faux' }, new AbortController().signal, owner,
        { provider: 'cloudflare', model: 'faux-model', apiToken: '' });
      expect(getCurrentSystemPrompt(captured[0].messages)).not.toContain(bot.instructions);
      const preferences = captured[0].messages.find((message: any) => message.role === 'user' &&
        JSON.stringify(message.content).includes('reusable bot configuration'));
      expect(preferences).toBeDefined();
      expect(JSON.stringify(preferences.content)).toContain('Preserve exact identifiers.');
      expect(JSON.stringify(preferences.content)).toContain('Never claim a memory was saved');
      const { makeOverseerStorage } = await import('../src/storage-schema/overseer-storage');
      expect(makeOverseerStorage(state.storage).chatMeta.get(chatId)?.bot).toEqual(bot);
      expect([...impl.storage.chats.list()].filter((message: any) => message.author.type === 'user'))
        .toMatchObject([{ message: 'Check the evidence.' }]);
    });
  });
});
