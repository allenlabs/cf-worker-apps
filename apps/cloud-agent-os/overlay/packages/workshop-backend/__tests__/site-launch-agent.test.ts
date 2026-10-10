import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { createFauxCore, fauxAssistantMessage, fauxText, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../src/agent';
import './test-worker';
const site = { id: 'verified-site-one', environment: 'production' as const, displayName: 'Site One', timezone: 'Asia/Seoul' };
const owner = { type: 'user' as const, id: 'owner@example.invalid', name: 'Owner' };
let count = 0;
async function prompt(scoped: boolean, spawned: boolean) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`site-prompt-${++count}`), async instance => {
    const impl = (instance as any).impl;
    if (scoped) impl.storage.siteContext.put(site);
    const chatId = 1;
    impl.storage.chatMeta.put({ id: chatId, title: 'Chat', started: new Date(0), lastActive: new Date(0) });
    impl.storage.chats.put({ chatId, sequence: impl.nextChatSequence(chatId), timestamp: new Date(0), author: owner, type: 'message', message: 'Hello' });
    if (spawned) impl.storage.chatContext.put({ chatId, spawnerConfig: { displayName: 'Child', modelId: null, env: {} }, bindings: {} });
    const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
    let seen = '';
    faux.setResponses([(context: any) => { seen = getCurrentSystemPrompt(context.messages); return fauxAssistantMessage([fauxText('Done')]); }]);
    await runAgent(impl, { model: faux.getModel(), stream: faux.stream }, chatId,
      { type: 'agent', id: 'faux-model', name: 'Faux' }, new AbortController().signal, owner,
      { provider: 'cloudflare', model: 'faux-model', apiToken: '' } as any);
    return seen;
  });
}
describe('verified workspace site in actual model context', () => {
  it.each([false, true])('includes immutable selection for spawned=%s without granting access', async spawned => {
    const result = await prompt(true, spawned);
    expect(result).toContain('# Verified site context');
    expect(result).toContain(JSON.stringify(site));
    expect(result).toContain('This selection grants no resource access');
  });
  it.each([false, true])('keeps ordinary workspace prompt unchanged for spawned=%s', async spawned => {
    const result = await prompt(false, spawned);
    expect(result).not.toContain('# Verified site context');
    expect(result).not.toContain(site.id);
  });
  it('omits ambient Context provisioning only in a scoped workspace', async () => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`site-ambient-${++count}`), async instance => {
      const impl = (instance as any).impl;
      impl.ownerId = 'synthetic-owner';
      let reached = 0;
      impl.ownerUserDo = () => ({ listProvidedAccounts: async () => { reached++; return []; } });
      await impl.ensureAmbientCapsules(); expect(reached).toBe(1);
      impl.storage.siteContext.put(site);
      await impl.ensureAmbientCapsules(); expect(reached).toBe(1);
    });
  });
});
