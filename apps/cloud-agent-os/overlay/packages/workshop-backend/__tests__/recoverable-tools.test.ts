import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { runAgent, MAX_TOOL_RESULT_CHARS } from '../src/agent';
import { formatWebFetchResult } from '../src/web-fetch';
import './test-worker';

const owner = { type: 'user' as const, id: 'recoverable-tools@example.invalid', name: 'Owner' };
let serial = 0;
afterEach(() => vi.unstubAllGlobals());

describe('recoverable model-facing tool results', () => {
  it('archives the entire acquired web response before returning a bounded page and replays it without refetching', async () => {
    const body = JSON.stringify({ data: '한글🌿'.repeat(13000), final: 'EXACT-JSON-END' });
    const url = 'https://source.example/large';
    const fetched: string[] = [];
    vi.stubGlobal('fetch', async (input: string | Request | URL) => {
      const requested = input instanceof Request ? input.url : String(input);
      if (requested !== url || fetched.length) throw new Error('Unexpected external request');
      fetched.push(requested);
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    });
    await runInDurableObject(env.TEST_OVERSEER.getByName(`recoverable-tool-${++serial}`), async instance => {
      const impl = (instance as any).impl, chatId = 1;
      impl.listConnectableVendors = async () => [];
      impl.storage.chatMeta.put({ id: chatId, title: 'Archive', started: new Date(0), lastActive: new Date(0) });
      impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: new Date(1),
        author: owner, type: 'message', message: 'Read the complete source.' });
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('webFetch', { url, raw: true }, { id: 'large-fetch' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('The source is archived.')),
      ]);
      const handle = { model: faux.getModel(), stream: faux.stream };
      const model = { provider: 'cloudflare' as const, model: 'faux-model', apiToken: '' };
      const author = { type: 'agent' as const, id: 'faux-model', name: 'Faux' };
      await runAgent(impl, handle, chatId, author, new AbortController().signal, owner, model);
      const messages = [...impl.storage.chats.list()];
      const call = messages.flatMap((message: any) => message.toolCalls ?? []).find((call: any) => call.toolName === 'webFetch');
      expect(call.archivedOutput).toBeDefined();
      expect(call.output.length).toBeLessThan(MAX_TOOL_RESULT_CHARS);
      const first = JSON.parse(call.output);
      expect(first.eof).toBe(false);
      let page = first, recovered = first.content;
      while (page.nextCursor) {
        page = await impl.readChatText(chatId, first.artifactId, { cursor: page.nextCursor });
        recovered += page.content;
      }
      expect(recovered).toBe(formatWebFetchResult({ status: 200, finalUrl: url,
        contentType: 'application/json', body, truncated: false }));
      impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: impl.getChatTimestamp(),
        author: owner, type: 'message', message: 'Continue using the same source.' });
      let replay = '';
      faux.setResponses([context => {
        replay = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxText('Continued using stored evidence.'));
      }]);
      await runAgent(impl, handle, chatId, author, new AbortController().signal, owner, model);
      expect(replay).toContain(first.artifactId);
      expect(replay).not.toContain('truncated: true');
      expect(messages[0].message).toBe('Read the complete source.');
    });
    expect(fetched).toEqual([url]);
  });

  it('returns native code output beyond the platform log cap through RPC, archives it, and never re-executes on replay', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`recoverable-code-${++serial}`), async instance => {
      const impl = (instance as any).impl, chatId = 1;
      impl.listConnectableVendors = async () => [];
      impl.storage.chatMeta.put({ id: chatId, title: 'Code output', started: new Date(0), lastActive: new Date(0) });
      impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: new Date(1),
        author: owner, type: 'message', message: 'Execute once and keep the complete output.' });
      const execute = impl.executeCodeMode.bind(impl);
      let runs = 0;
      impl.executeCodeMode = (...args: unknown[]) => {
        if (++runs > 1) throw new Error('Code must not execute again during history replay');
        return execute(...args);
      };
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('executeCode', { code:
          'console.log("MODULE-BEGIN"); export default function() { console.log("x".repeat(300000)); return "RETURN-END"; }',
        }, { id: 'large-code' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('The complete output is stored.')),
      ]);
      const handle = { model: faux.getModel(), stream: faux.stream };
      const model = { provider: 'cloudflare' as const, model: 'faux-model', apiToken: '' };
      const author = { type: 'agent' as const, id: 'faux-model', name: 'Faux' };
      await runAgent(impl, handle, chatId, author, new AbortController().signal, owner, model);
      const call = [...impl.storage.chats.list()].flatMap((message: any) => message.toolCalls ?? [])
          .find((call: any) => call.toolName === 'executeCode');
      expect(call.error).toBeUndefined();
      expect(call.archivedOutput).toBeDefined();
      let page = JSON.parse(call.output), recovered = page.content;
      while (page.nextCursor) {
        page = await impl.readChatText(chatId, page.artifactId, { cursor: page.nextCursor });
        recovered += page.content;
      }
      expect(recovered).toBe('MODULE-BEGIN\n' + 'x'.repeat(300000) + '\nReturn value: RETURN-END');
      impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: impl.getChatTimestamp(),
        author: owner, type: 'message', message: 'Continue from the saved output.' });
      let replay = '';
      faux.setResponses([context => {
        replay = JSON.stringify(context.messages);
        return fauxAssistantMessage(fauxText('Using the saved output.'));
      }]);
      await runAgent(impl, handle, chatId, author, new AbortController().signal, owner, model);
      expect(replay).toContain(call.archivedOutput.id);
      expect(runs).toBe(1);
    });
  });
});
