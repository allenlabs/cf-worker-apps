import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createFauxCore, fauxAssistantMessage, fauxText, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import type { AiChatAuthorInfo, AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api';
import { describe, expect, it } from 'vitest';
import { runAgent, type AgentHooks } from '../src/agent';
import './test-worker';

interface OverseerInternals extends AgentHooks {
  storage: {
    chatMeta: { put(meta: AiChatMetadata): void };
    chats: { put(message: AiChatMessage): void; list(): Iterable<AiChatMessage> };
  };
  nextChatSequence(chatId: number): number;
}

const owner: AiChatAuthorInfo = { type: 'user', id: 'startup-owner@example.invalid', name: 'Owner' };
const author: AiChatAuthorInfo = { type: 'agent', id: 'faux-model', name: 'Faux' };
const formats = '# Standard output formats\nSynthetic report — preserve 한글 🌿.';
const vendors = [{ id: 'synthetic-source', displayName: 'Synthetic source 한글' }];
let serial = 0;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function withImpl(action: (impl: OverseerInternals) => Promise<void>) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`startup-concurrency-${++serial}`), async instance => {
    const impl = (instance as unknown as { impl: OverseerInternals }).impl;
    impl.storage.chatMeta.put({ id: 1, title: 'Chat', started: new Date(0), lastActive: new Date(0) });
    impl.storage.chats.put({ chatId: 1, sequence: impl.nextChatSequence(1), timestamp: new Date(0),
      author: owner, type: 'message', message: 'Prepare the report.' });
    impl.getPromptCacheSalt = () => 'synthetic-startup-salt';
    await action(impl);
  });
}

function launch(impl: OverseerInternals) {
  const prompts: string[] = [];
  const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
  faux.setResponses([context => {
    prompts.push(getCurrentSystemPrompt(context.messages));
    return fauxAssistantMessage(fauxText('Report ready.'));
  }]);
  // Attach the rejection handler immediately: a deliberately failed dependency must remain
  // observable without producing an unrelated unhandled rejection while the other is gated.
  const outcome = runAgent(impl, { model: faux.getModel(), stream: faux.stream }, 1, author,
    new AbortController().signal, owner, { provider: 'cloudflare', model: 'faux-model', apiToken: '' })
    .then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
  return { prompts, outcome };
}

describe('agent prompt startup reads', () => {
  it.each(['formats', 'vendors'] as const)('starts both reads and waits for both when %s finishes first', async first => {
    let expectedPrompt = '';
    await withImpl(async impl => {
      impl.describeStandardFormats = async () => formats;
      impl.listConnectableVendors = async () => vendors;
      const baseline = launch(impl);
      expect(await baseline.outcome).toEqual({ ok: true });
      expect(baseline.prompts).toHaveLength(1);
      expectedPrompt = baseline.prompts[0];
      expect(expectedPrompt.split(formats)).toHaveLength(2);
      expect(expectedPrompt.split('* synthetic-source: Synthetic source 한글')).toHaveLength(2);
    });

    await withImpl(async impl => {
      const formatRead = deferred<string>();
      const vendorRead = deferred<typeof vendors>();
      const began = deferred<void>();
      const started: string[] = [];
      impl.describeStandardFormats = () => { started.push('formats'); began.resolve(); return formatRead.promise; };
      impl.listConnectableVendors = () => { started.push('vendors'); return vendorRead.promise; };
      const running = launch(impl);
      await began.promise;
      try {
        expect(started).toEqual(['formats', 'vendors']);
        expect(running.prompts).toEqual([]);
        if (first === 'formats') formatRead.resolve(formats);
        else vendorRead.resolve(vendors);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(running.prompts).toEqual([]);
        expect([...impl.storage.chats.list()]).toHaveLength(1);
        formatRead.resolve(formats);
        vendorRead.resolve(vendors);
        expect(await running.outcome).toEqual({ ok: true });
        expect(running.prompts).toEqual([expectedPrompt]);
        expect([...impl.storage.chats.list()].flatMap(message => message.type === 'message' ? [message.message] : []))
          .toEqual(['Prepare the report.', 'Report ready.']);
      } finally {
        formatRead.resolve(formats);
        vendorRead.resolve(vendors);
        await running.outcome;
      }
    });
  });

  it.each(['formats', 'vendors'] as const)('surfaces a failed %s read without invoking the provider or committing a response', async failed => {
    await withImpl(async impl => {
      const formatRead = deferred<string>();
      const vendorRead = deferred<typeof vendors>();
      const began = deferred<void>();
      const started: string[] = [];
      impl.describeStandardFormats = () => { started.push('formats'); began.resolve(); return formatRead.promise; };
      impl.listConnectableVendors = () => { started.push('vendors'); return vendorRead.promise; };
      const before = [...impl.storage.chats.list()];
      const running = launch(impl);
      let settled = false;
      void running.outcome.then(() => { settled = true; });
      await began.promise;
      try {
        expect(started).toEqual(['formats', 'vendors']);
        const failure = new Error(`Synthetic ${failed} read unavailable`);
        if (failed === 'formats') formatRead.reject(failure);
        else vendorRead.reject(failure);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(settled).toBe(true);
        expect(await running.outcome).toEqual({ ok: false, error: failure });
        expect(running.prompts).toEqual([]);
        expect([...impl.storage.chats.list()]).toEqual(before);
      } finally {
        formatRead.resolve(formats);
        vendorRead.resolve(vendors);
        await running.outcome;
      }
    });
  });
});
