import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createFauxCore, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai';
import { completeText } from '../src/ai-invoke';
import { runAgent } from '../src/agent';
import './test-worker';

let serial = 0;
const owner = { type: 'user' as const, id: 'archive-owner@example.invalid', name: 'Owner' };
const seed = (impl: any, id = 1) => impl.storage.chatMeta.put({ id, title: 'Archive test', started: new Date(id), lastActive: new Date(id) });

describe('canonical history and text preservation', () => {
  it('reconstructs an archived Unicode result after reopening storage and denies another chat', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`archive-runtime-${++serial}`), async (instance, state) => {
      const impl = (instance as any).impl;
      seed(impl); seed(impl, 2);
      const original = JSON.stringify({ data: '한글 🌿\\\"\n'.repeat(12000), end: 'EXACT-END' });
      const reference = await impl.archiveChatText(1, original);
      const { makeOverseerStorage } = await import('../src/storage-schema/overseer-storage');
      impl.storage = makeOverseerStorage(state.storage);
      let cursor: string | undefined = reference.startCursor, recovered = '';
      do {
        const page = await impl.readChatText(1, reference.id, { cursor });
        expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(8192);
        recovered += page.content;
        cursor = page.nextCursor ?? undefined;
        expect(page.eof).toBe(cursor === undefined);
      } while (cursor);
      expect(recovered).toBe(original);
      expect(JSON.parse(recovered).end).toBe('EXACT-END');
      await expect(impl.readChatText(2, reference.id, {})).rejects.toThrow(/unavailable|not found/i);
    });
  });

  it('pages an entire pre-compaction record without mutating originals or losing its last characters', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`history-runtime-${++serial}`), async instance => {
      const impl = (instance as any).impl;
      seed(impl);
      const first = { chatId: 1, sequence: 0, timestamp: new Date(0), author: owner,
        type: 'message', message: 'Keep these original requirements.\n' + '한글🌿'.repeat(20000) + '\nLAST REQUIREMENT' };
      const second = { ...first, sequence: 1, timestamp: new Date(1), message: 'Continue.' };
      impl.storage.chats.put(first); impl.storage.chats.put(second);
      impl.commitChatCompaction(1, { chatId: 1, compactedTo: 1, summary: 'A shorter handoff', bindings: {} });
      expect(impl.loadChatHistory(1).chatMessages).toHaveLength(1);
      const found = await impl.readChatHistoryPage(1, 0);
      expect(found.sequence).toBe(0);
      expect(found.nextSequence).toBe(1);
      let page = found.page;
      let text = page.content;
      while (page.nextCursor) {
        page = await impl.readChatText(1, page.artifactId, { cursor: page.nextCursor });
        text += page.content;
      }
      expect(JSON.parse(text).message).toBe(first.message);
      expect([...impl.storage.chats.list()]).toEqual([first, second]);
      expect((await impl.readChatHistoryPage(1, 2)).sequence).toBeNull();
      await expect(impl.readChatHistoryPage(1, -1)).rejects.toThrow(/sequence/i);
    });
  });

  it('rejects a length-limited handoff instead of treating its prefix as a complete summary', async () => {
    const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
    const partial = fauxAssistantMessage([fauxText('## Goal\nThe unfinished require')]);
    partial.stopReason = 'length';
    faux.setResponses([partial]);
    await expect(completeText({ model: faux.getModel(), stream: faux.stream }, {
      prompt: 'Summarize the conversation.', requireComplete: true,
    })).rejects.toThrow(/incomplete|limit/i);
  });

  it('does not accept a summary when its transport fails after a terminal frame', async () => {
    const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
    faux.setResponses([fauxAssistantMessage(fauxText('Apparently finished summary'))]);
    const stream: typeof faux.stream = async (...args) => {
      const underlying = await faux.stream(...args);
      return {
        result: () => underlying.result(),
        async *[Symbol.asyncIterator]() {
          for await (const event of underlying) yield event;
          throw new Error('Synthetic summary transport failed after terminal frame');
        },
      } as typeof underlying;
    };
    await expect(completeText({ model: faux.getModel(), stream }, {
      prompt: 'Summarize', requireComplete: true,
    })).rejects.toThrow(/transport failed/);
  });

  it('keeps the checkpoint and every original record when an explicit compaction is incomplete', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`compaction-original-${++serial}`), async instance => {
      const impl = (instance as any).impl;
      seed(impl);
      impl.listConnectableVendors = async () => [];
      const records = [
        { chatId: 1, sequence: 0, timestamp: new Date(0), author: owner, type: 'message', message: 'An exact original requirement.' },
        { chatId: 1, sequence: 1, timestamp: new Date(1), author: owner, type: 'message', message: 'Another exact requirement.' },
        { chatId: 1, sequence: 2, timestamp: new Date(2), author: owner, type: 'slashCommand', request: { id: { builtin: true, commandId: 'compact' }, args: '' } },
      ];
      records.forEach(record => impl.storage.chats.put(record));
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      faux.setResponses([fauxAssistantMessage(fauxText('A cut-off handoff'), { stopReason: 'length' })]);
      await expect(runAgent(impl, { model: faux.getModel(), stream: faux.stream }, 1,
        { type: 'agent', id: 'faux-model', name: 'Faux' }, new AbortController().signal, owner,
        { provider: 'cloudflare', model: 'faux-model', apiToken: '' })).rejects.toThrow(/incomplete/i);
      expect(impl.storage.chatMeta.get(1).compactedTo).toBeUndefined();
      expect([...impl.storage.chatCompactions.list()]).toEqual([]);
      expect([...impl.storage.chats.list()]).toEqual(records);
    });
  });

  it('carries plugin access requirements when a recovery-tool record is archived again', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`archive-provenance-${++serial}`), async instance => {
      const impl = (instance as any).impl;
      seed(impl);
      let permitted = true;
      impl.getAgentResources = async () => permitted ? [{ id: 'restricted-plugin', enabled: true }] : [];
      const first = await impl.archiveChatText(1, 'RESTRICTED ORIGINAL', ['restricted-plugin']);
      const page = await impl.readChatText(1, first.id, {}, owner);
      impl.storage.chats.put({ chatId: 1, sequence: 0, timestamp: new Date(0), author: { ...owner, type: 'agent' },
        type: 'message', message: '', toolCalls: [{ toolCallId: 'read-one', toolName: 'readStoredText',
          input: { artifactId: first.id }, output: JSON.stringify(page), sourceArtifactId: first.id }] });
      const nested = await impl.readChatHistoryPage(1, 0, owner);
      permitted = false;
      await expect(impl.readChatText(1, first.id, {}, owner)).rejects.toThrow(/access/i);
      await expect(impl.readChatText(1, nested.page.artifactId, {}, owner)).rejects.toThrow(/access/i);
      await expect(impl.readChatHistoryPage(1, 0, owner)).rejects.toThrow(/access/i);
      expect([...impl.storage.chats.list()]).toHaveLength(1);
    });
  });
});
