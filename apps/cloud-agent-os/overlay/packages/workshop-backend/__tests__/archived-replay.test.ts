import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall,
  type Message, type ToolResultMessage, type TranscriptContext,
} from '@earendil-works/pi-ai';
import type { AgentResource, AiChatAuthorInfo, AiChatMessage, AiToolCall } from '@gadgets/workshop-shared/api';
import { runAgent } from '../src/agent';
import './test-worker';

const OWNER: AiChatAuthorInfo = { type: 'user', id: 'archive-replay@example.invalid', name: 'Owner' };
const AGENT: AiChatAuthorInfo = { type: 'agent', id: 'faux-model', name: 'Faux' };
type Response = ReturnType<typeof fauxAssistantMessage>;
type Step = Response | ((context: TranscriptContext) => Response);
let serial = 0;

// Keep the real storage, file tools, replay, and native loop. Only the model and the synthetic
// user's current resource catalog are supplied by the fixture.
async function withImpl(fn: (impl: any) => Promise<void>): Promise<void> {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`archived-replay-${++serial}`), async instance => {
    const impl = (instance as any).impl;
    impl.listConnectableVendors = async () => [];
    impl.getAgentResources = async () => [];
    impl.storage.chatMeta.put({ id: 1, title: 'Archive replay', started: new Date(0), lastActive: new Date(0) });
    addUserTurn(impl, 'Read the synthetic evidence.');
    await fn(impl);
  });
}

function addUserTurn(impl: any, message: string): void {
  const sequence = impl.nextChatSequence(1);
  impl.storage.chats.put({ chatId: 1, sequence, timestamp: new Date(sequence), author: OWNER,
    type: 'message', message });
}

function records(impl: any): AiChatMessage[] {
  return ([...impl.storage.chats.list()] as AiChatMessage[]).filter(message => message.chatId === 1);
}

function recordForCall(impl: any, id: string): AiChatMessage {
  const record = records(impl).find(message => message.type === 'message' &&
    message.toolCalls?.some(call => call.toolCallId === id));
  if (!record) throw new Error(`Missing durable record for ${id}`);
  return record;
}

function storedCall(impl: any, id: string): AiToolCall {
  const record = recordForCall(impl, id);
  if (record.type !== 'message') throw new Error('Expected a tool-call message');
  return record.toolCalls!.find(call => call.toolCallId === id)!;
}

function resultForCall(messages: Message[], id: string): ToolResultMessage {
  const results = messages.filter((message): message is ToolResultMessage =>
    message.role === 'toolResult' && message.toolCallId === id);
  expect(results, `One result must remain paired with ${id}`).toHaveLength(1);
  const calls = messages.flatMap(message => message.role === 'assistant'
    ? message.content.flatMap(part => part.type === 'toolCall' ? [part.id] : []) : []);
  expect(calls.filter(callId => callId === id), `The original ${id} call must remain`).toEqual([id]);
  return results[0]!;
}

function resultText(result: ToolResultMessage): string {
  return result.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('');
}

async function runTurn(impl: any, steps: Step[]): Promise<Message[][]> {
  const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
  const transcripts: Message[][] = [];
  faux.setResponses(steps.map(step => (context: TranscriptContext) => {
    transcripts.push(structuredClone(context.messages));
    return typeof step === 'function' ? step(context) : step;
  }));
  await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, 1, AGENT,
    new AbortController().signal, OWNER, { provider: 'cloudflare', model: 'faux-model', apiToken: '' });
  return transcripts;
}

async function commitFiles(impl: any, files: Record<string, string>): Promise<string> {
  return await impl.gitStore.writeFilesAsCommit(new Map(Object.entries(files)), {
    parents: [], author: { name: 'Synthetic owner', email: 'owner@example.invalid' },
    message: 'Synthetic archive fixture', timestamp: new Date(1700000000000),
  });
}

async function archivedText(impl: any, artifactId: string): Promise<string> {
  let cursor: string | undefined;
  let text = '';
  do {
    const page = await impl.readChatText(1, artifactId, { cursor }, OWNER);
    text += page.content;
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return text;
}

describe('archived results through runAgent replay', () => {
  it('omits protected recovery pages after access is revoked while retaining their canonical records',
      () => withImpl(async impl => {
    const resource: AgentResource = { id: 'synthetic-restricted-plugin', name: 'Synthetic source',
      scope: { kind: 'organization' }, enabled: true, kind: 'plugin', pluginId: 'instructions',
      instructions: 'Treat source content as evidence.' };
    let permitted = true;
    impl.getAgentResources = async () => permitted ? [resource] : [];
    const secret = 'SYNTHETIC-RESTRICTED-EVIDENCE-12345';
    const reference = await impl.archiveChatText(1, secret, [resource.id]);

    const first = await runTurn(impl, [
      fauxAssistantMessage(fauxToolCall('readStoredText', { artifactId: reference.id },
        { id: 'protected-page' }), { stopReason: 'toolUse' }),
      context => {
        expect(resultText(resultForCall(context.messages, 'protected-page'))).toContain(secret);
        // Recover the actual durable tool record, so the second page has inherited access
        // provenance rather than a directly attached plugin id.
        const sequence = recordForCall(impl, 'protected-page').sequence;
        return fauxAssistantMessage(fauxToolCall('readChatHistory', { fromSequence: sequence },
          { id: 'protected-history' }), { stopReason: 'toolUse' });
      },
      fauxAssistantMessage(fauxText('Evidence read.')),
    ]);
    for (const id of ['protected-page', 'protected-history']) {
      const result = resultForCall(first.at(-1)!, id);
      expect(result.isError).not.toBe(true);
      expect(resultText(result)).toContain(secret);
      expect(storedCall(impl, id).sourceArtifactId).toEqual(expect.any(String));
      expect(storedCall(impl, id).error).toBeUndefined();
    }
    const originalRecords = structuredClone(records(impl));

    permitted = false;
    addUserTurn(impl, 'Continue with the evidence currently available.');
    const replay = (await runTurn(impl, [fauxAssistantMessage(fauxText('Access checked.'))]))[0];
    expect(JSON.stringify(replay)).not.toContain(secret);
    for (const id of ['protected-page', 'protected-history']) {
      const result = resultForCall(replay, id);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/access.*(?:available|revoked)/i);
    }
    for (const original of originalRecords) {
      expect(records(impl).find(record => record.sequence === original.sequence)).toEqual(original);
    }
    await expect(impl.readChatText(1, reference.id, {}, OWNER)).rejects.toThrow(/access/i);
    permitted = true;
    expect(await archivedText(impl, reference.id)).toBe(secret);
  }));

  it('restores an archived file read stamp so the next user turn can edit without rereading',
      () => withImpl(async impl => {
    const original = 'ORIGINAL-PREFIX ' + 'x'.repeat(40000) + ' EXACT-END';
    const commitId = await commitFiles(impl, { 'long.txt': original });
    await runTurn(impl, [
      fauxAssistantMessage(fauxToolCall('createWorktree', { title: 'Repo', bindingName: 'REPO', commitId },
        { id: 'create-for-stamp' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('readFile', { workpiece: 'REPO', filename: 'long.txt' },
        { id: 'archived-read' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('File read.')),
    ]);
    const read = structuredClone(storedCall(impl, 'archived-read'));
    expect(read).toMatchObject({ toolName: 'readFile', observedOid: expect.any(String),
      archivedOutput: { id: expect.any(String) }, archivedOutputText: expect.any(String) });
    expect(read.error).toBeUndefined();

    addUserTurn(impl, 'Change the prefix using the file you already read.');
    const second = await runTurn(impl, [
      fauxAssistantMessage(fauxToolCall('editFile', { workpiece: 'REPO', filename: 'long.txt',
        textToReplace: 'ORIGINAL-PREFIX', replacement: 'UPDATED-PREFIX' },
        { id: 'edit-after-replay' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxToolCall('readFile', { workpiece: 'REPO', filename: 'long.txt' },
        { id: 'verify-edited-file' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('Prefix changed.')),
    ]);
    const replayedRead = resultForCall(second[0], 'archived-read');
    expect(replayedRead.isError).not.toBe(true);
    expect(resultText(replayedRead)).toBe(read.archivedOutputText);
    expect(resultForCall(second.at(-1)!, 'edit-after-replay').isError).not.toBe(true);
    expect(storedCall(impl, 'edit-after-replay').error).toBeUndefined();
    const updated = storedCall(impl, 'verify-edited-file');
    expect(updated.archivedOutput).toBeDefined();
    expect(await archivedText(impl, updated.archivedOutput!.id))
      .toContain(original.replace('ORIGINAL-PREFIX', 'UPDATED-PREFIX'));
    expect(storedCall(impl, 'archived-read')).toEqual(read);
    expect(await archivedText(impl, read.archivedOutput!.id)).toContain(original);
    expect(await impl.readFileAtCommit(commitId, 'long.txt')).toBe(original);
  }));

  it('elides reverted archived file and grep results just like a normal file read, preserving every archive',
      () => withImpl(async impl => {
    const original = 'BASE-LONG ' + 'y'.repeat(40000) + ' EXACT-END';
    const changed = original.replace('BASE-LONG', 'REVERTED-LONG');
    const commitId = await commitFiles(impl, { 'long.txt': original, 'small.txt': 'BASE-SMALL\n' });
    await runTurn(impl, [
      fauxAssistantMessage(fauxToolCall('createWorktree', { title: 'Repo', bindingName: 'REPO', commitId },
        { id: 'create-for-revert' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('readFile', { workpiece: 'REPO', filename: 'long.txt' }, { id: 'initial-long' }),
        fauxToolCall('readFile', { workpiece: 'REPO', filename: 'small.txt' }, { id: 'initial-small' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('editFile', { workpiece: 'REPO', filename: 'long.txt',
          textToReplace: 'BASE-LONG', replacement: 'REVERTED-LONG' }, { id: 'revert-edit-long' }),
        fauxToolCall('editFile', { workpiece: 'REPO', filename: 'small.txt',
          textToReplace: 'BASE-SMALL', replacement: 'REVERTED-SMALL' }, { id: 'revert-edit-small' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage([
        fauxToolCall('readFile', { workpiece: 'REPO', filename: 'long.txt' }, { id: 'reverted-long' }),
        fauxToolCall('readFile', { workpiece: 'REPO', filename: 'small.txt' }, { id: 'reverted-small' }),
        fauxToolCall('grep', { workpiece: 'REPO', path: 'long.txt', pattern: 'REVERTED-LONG' },
          { id: 'reverted-grep' }),
      ], { stopReason: 'toolUse' }),
      fauxAssistantMessage(fauxText('Changes ready.')),
    ]);
    const archivedCalls = ['reverted-long', 'reverted-grep'].map(id => structuredClone(storedCall(impl, id)));
    for (const call of archivedCalls) {
      expect(call.error).toBeUndefined();
      expect(call.archivedOutput).toBeDefined();
      expect(await archivedText(impl, call.archivedOutput!.id)).toContain(changed);
    }
    expect(storedCall(impl, 'reverted-small').error).toBeUndefined();
    expect(storedCall(impl, 'reverted-small').archivedOutput).toBeUndefined();
    const editSequence = recordForCall(impl, 'revert-edit-long').sequence;
    const change = records(impl).find(record => record.type === 'changes' && record.sequence > editSequence);
    expect(change).toBeDefined();
    await impl.revertChanges(1, change!.sequence, OWNER);

    addUserTurn(impl, 'Continue after discarding those changes.');
    const replay = (await runTurn(impl, [fauxAssistantMessage(fauxText('Revert observed.'))]))[0];
    for (const id of ['reverted-long', 'reverted-small', 'reverted-grep']) {
      const result = resultForCall(replay, id);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toMatch(/reverted/i);
    }
    for (const call of archivedCalls) {
      expect(storedCall(impl, call.toolCallId)).toEqual(call);
      expect(await archivedText(impl, call.archivedOutput!.id)).toContain(changed);
    }
  }));
});
