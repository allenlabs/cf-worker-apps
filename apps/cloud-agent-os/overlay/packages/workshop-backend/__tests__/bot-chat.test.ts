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

describe('bot chat selection and replay', () => {
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
