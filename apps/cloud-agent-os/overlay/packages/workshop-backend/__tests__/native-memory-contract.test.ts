import { describe, expect, it } from 'vitest';
import { memoryProfileName, memorySessionId, readNativeMemoryConfig } from '../src/native-memory';

describe('native Agent Memory binding contract', () => {
  it('keeps bot and session identity within the documented limits', async () => {
    const profile = await memoryProfileName('owner@example.invalid', 'generated-bot');
    expect(profile.length).toBeLessThanOrEqual(100);
    expect(await memoryProfileName('owner@example.invalid', 'other-bot')).not.toBe(profile);
    expect((await memorySessionId('generated-workspace', 123)).length).toBeLessThanOrEqual(64);
  });
  it('does not infer automatic capture when the deployment has not enabled it', () => {
    expect(readNativeMemoryConfig({})).toBeUndefined();
    expect(readNativeMemoryConfig({ AUTO_MEMORY_OWNER: 'owner@example.invalid', AUTO_MEMORY_NAMESPACE: 'test-memory' }))
      .toEqual({ principal: 'owner@example.invalid', namespace: 'test-memory' });
  });
});

import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { NativeMemoryQueue, type MemoryMessage } from '../src/native-memory';
import { createMemorySource } from '../src/native-memory-host';
import { makeOverseerStorage } from '../src/storage-schema/overseer-storage';
import './test-worker';

let serial = 0;
describe('native memory with actual workspace storage and archive pages', () => {
  it('keeps full canonical text and resumes the same frozen batch from durable storage', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`native-memory-${++serial}`), async (instance, state) => {
      const impl = (instance as any).impl;
      const owner = { type: 'user' as const, id: 'memory-owner@example.invalid', name: 'Owner' };
      const chatId = 1;
      const original = '\ufeff한국어 👨‍👩‍👧‍👦 '+JSON.stringify({ body: '\n"\\'.repeat(10_000), end: '마지막 END' });
      impl.storage.chatMeta.put({ id: chatId, title: 'Memory test', started: new Date(0), lastActive: new Date(0) });
      impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: new Date(0), author: owner,
        type: 'message', message: original });
      const source = createMemorySource({
        assertAccess: id => { if (!impl.storage.chatMeta.get(id)) throw new Error('Chat deleted'); },
        record: (id, sequence) => [...impl.storage.chats.list()].find((record: any) => record.chatId === id && record.sequence === sequence),
        history: (id, sequence) => impl.readChatHistoryPage(id, sequence, owner),
        readText: (id, artifact, cursor) => impl.readChatText(id, artifact, { cursor, maxBytes: 4096 }, owner),
        archive: (id, text) => impl.archiveChatText(id, text),
        attachment: (id, attachment) => impl.getChatAttachmentData(id, attachment),
        isTextAttachment: () => false,
      });
      let now = Date.now(), fail = true;
      const calls: Array<{ messages: MemoryMessage[]; options: { sessionId: string } }> = [];
      const deps = { principal: owner.id, namespace: 'test-memory', workspaceId: state.id.toString(), now: () => now,
        source, store: {
          get: (id: number) => impl.storage.nativeMemory.get(id),
          put: (value: any) => { impl.storage.nativeMemory.put(value); },
          delete: (id: number) => { impl.storage.nativeMemory.delete(id); },
          list: () => [...impl.storage.nativeMemory.list()],
          transaction: <T>(callback: () => T) => state.storage.transactionSync(callback),
        }, binding: { async getProfile() { return {
          async ingest(messages: MemoryMessage[], options: { sessionId: string }) {
            calls.push(structuredClone({ messages, options })); if (fail) throw new Error('Synthetic transient failure');
          }, async recall() { return { count: 0, answer: '', candidates: [] }; },
        }; } },
      };
      let queue = new NativeMemoryQueue(deps);
      queue.enroll(chatId, 'generated-bot', 1); now += 60_000; await queue.drain();
      expect(queue.status(chatId).acknowledgedThrough).toBe(-1);
      expect(makeOverseerStorage(state.storage).nativeMemory.get(chatId)?.pending).toBeDefined();
      const first = structuredClone(calls[0]); fail = false;
      queue = new NativeMemoryQueue(deps);
      for (let n = 0; n < 300 && queue.nextAlarm() !== null; n++) { now += 4_000_000; await queue.drain(); }
      expect(calls[1]).toEqual(first);
      expect(queue.status(chatId).state).toBe('caught-up');
      const accepted = calls.slice(1).flatMap(call => call.messages.map(message => JSON.parse(message.content)));
      const restored = JSON.parse(accepted.filter(frame => frame.source === 'chat-record').map(frame => frame.content).join(''));
      expect(restored.message).toBe(original);
      expect([...impl.storage.chats.list()].find((record: any) => record.chatId === chatId).message).toBe(original);
    });
  });
});
