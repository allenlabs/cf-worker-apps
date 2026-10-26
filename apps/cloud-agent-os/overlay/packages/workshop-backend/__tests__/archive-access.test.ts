import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api';
import { describe, expect, it } from 'vitest';
import type { AgentHooks } from '../src/agent';
import type { makeOverseerStorage } from '../src/storage-schema/overseer-storage';
import './test-worker';

type ArchiveHost = Required<Pick<AgentHooks, 'archiveChatText' | 'readChatText' | 'getAgentResources'>> & {
  storage: ReturnType<typeof makeOverseerStorage>;
};

const owner: AiChatAuthorInfo = { type: 'user', id: 'archive-reader@example.invalid', name: 'Reader' };
let serial = 0;

async function withArchive(test: (host: ArchiveHost) => Promise<void>) {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`archive-access-${++serial}`), async instance => {
    const host = (instance as unknown as { impl: ArchiveHost }).impl;
    host.storage.chatMeta.put({ id: 1, title: 'Archive', started: new Date(0), lastActive: new Date(0) });
    await test(host);
  });
}

describe('archive access without unrelated resource lookups', () => {
  it('reads every exact Unicode page with empty provenance without consulting resource settings', () => withArchive(async host => {
    const original = '\ufeff한글 👨‍👩‍👧‍👦\n"\\'.repeat(2500);
    const ref = await host.archiveChatText(1, original);
    let lookups = 0;
    host.getAgentResources = async () => { lookups++; return []; };
    let cursor: string | undefined = ref.startCursor;
    let restored = '', pages = 0;
    do {
      const page = await host.readChatText(1, ref.id, { cursor }, owner);
      expect(new TextEncoder().encode(JSON.stringify(page)).length).toBeLessThanOrEqual(8192);
      expect(page.start).toBe(restored.length);
      restored += page.content;
      expect(page.end).toBe(restored.length);
      expect(page.eof).toBe(page.nextCursor === null);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(restored).toBe(original);
    expect(pages).toBeGreaterThan(1);
    expect(lookups).toBe(0);
  }));

  it('does not make unprotected original text depend on unavailable resource settings', () => withArchive(async host => {
    const ref = await host.archiveChatText(1, 'Original text');
    host.getAgentResources = async () => { throw new Error('Synthetic settings outage'); };
    expect((await host.readChatText(1, ref.id, {}, owner)).content).toBe('Original text');
  }));

  it('revalidates protected pages and rejects revocation without changing the original', () => withArchive(async host => {
    const original = 'Protected 한글 🌿'.repeat(2500);
    const ref = await host.archiveChatText(1, original);
    const key = `chat-text:1:${ref.id}:permissions`;
    host.storage.chatText.put({ key, value: ['restricted-plugin'] });
    const granted: Awaited<ReturnType<AgentHooks['getAgentResources']>> = [{ id: 'restricted-plugin',
      name: 'Synthetic plugin', scope: { kind: 'personal', userId: owner.id }, enabled: true,
      kind: 'skill', description: '', content: 'Synthetic instruction' }];
    let lookups = 0;
    host.getAgentResources = async () => { lookups++; return granted; };
    const first = await host.readChatText(1, ref.id, {}, owner);
    expect(first.nextCursor).not.toBeNull();
    host.getAgentResources = async () => { lookups++; return []; };
    await expect(host.readChatText(1, ref.id, { cursor: first.nextCursor! }, owner)).rejects.toThrow(/access/i);
    host.getAgentResources = async () => { lookups++; return granted; };
    expect(await host.readChatText(1, ref.id, {}, owner)).toEqual(first);
    expect(lookups).toBe(3);
    expect(host.storage.chatText.get(key)?.value).toEqual(['restricted-plugin']);
  }));

  it('preserves lookup failures for protected originals', () => withArchive(async host => {
    const ref = await host.archiveChatText(1, 'Protected original');
    host.storage.chatText.put({ key: `chat-text:1:${ref.id}:permissions`, value: ['restricted-plugin'] });
    host.getAgentResources = async () => { throw new Error('Synthetic settings outage'); };
    await expect(host.readChatText(1, ref.id, {}, owner)).rejects.toThrow('Synthetic settings outage');
  }));

  it.each([{ value: undefined }, { value: {} }, { value: ['valid', 1] }])('rejects absent or corrupt provenance ($value) before consulting resource settings', ({ value }) => withArchive(async host => {
    const ref = await host.archiveChatText(1, 'Original text');
    const key = `chat-text:1:${ref.id}:permissions`;
    if (value === undefined) host.storage.chatText.deleteRecord(host.storage.chatText.get(key)!);
    else host.storage.chatText.put({ key, value });
    let lookups = 0;
    host.getAgentResources = async () => { lookups++; return []; };
    await expect(host.readChatText(1, ref.id, {}, owner)).rejects.toThrow(/provenance/i);
    expect(lookups).toBe(0);
  }));

  it('requires every protected resource and a verified initiator', () => withArchive(async host => {
    const ref = await host.archiveChatText(1, 'Protected original');
    host.storage.chatText.put({ key: `chat-text:1:${ref.id}:permissions`, value: ['first', 'second'] });
    const resources: Awaited<ReturnType<AgentHooks['getAgentResources']>> = [
      { id: 'first', name: 'First', scope: { kind: 'personal', userId: owner.id }, enabled: true,
        kind: 'skill', description: '', content: 'First instruction' },
      { id: 'second', name: 'Second', scope: { kind: 'personal', userId: owner.id }, enabled: false,
        kind: 'skill', description: '', content: 'Second instruction' },
    ];
    host.getAgentResources = async () => resources.slice(0, 1);
    await expect(host.readChatText(1, ref.id, {})).rejects.toThrow(/access/i);
    await expect(host.readChatText(1, ref.id, {}, owner)).rejects.toThrow(/access/i);
    host.getAgentResources = async () => resources;
    await expect(host.readChatText(1, ref.id, {}, owner)).rejects.toThrow(/access/i);
    resources[1].enabled = true;
    expect((await host.readChatText(1, ref.id, {}, owner)).content).toBe('Protected original');
  }));

  it('does not permit empty-provenance reads from another or deleted chat', () => withArchive(async host => {
    const ref = await host.archiveChatText(1, 'Original text');
    host.storage.chatMeta.put({ id: 2, title: 'Other', started: new Date(2), lastActive: new Date(2) });
    let lookups = 0;
    host.getAgentResources = async () => { lookups++; return []; };
    await expect(host.readChatText(2, ref.id, {}, owner)).rejects.toThrow(/unavailable|not found/i);
    host.storage.chatMeta.deleteRecord(host.storage.chatMeta.get(1)!);
    await expect(host.readChatText(1, ref.id, {}, owner)).rejects.toThrow('No such chatId: 1');
    expect(lookups).toBe(0);
  }));
});
