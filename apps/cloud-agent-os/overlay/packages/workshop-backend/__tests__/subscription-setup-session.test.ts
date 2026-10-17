import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import './test-worker';
import server from '../src/server';
import { SubscriptionSetupSession } from '../src/subscription-setup-session';
import { makeUserStorage } from '../src/storage-schema/user-storage';
import { hashSecret } from '../src/connect-handoff';

const principal = { issuer: 'https://identity.example.invalid', subject: 'subscription-owner', email: 'owner@example.invalid' };

describe('private subscription setup session verification', () => {
  it('authenticates the existing User session and denies missing or deleted provenance', async () => {
    await runInDurableObject(env.TEST_USER.getByName(principal.email), async (user, state) => {
      const verifier = new SubscriptionSetupSession(createExecutionContext(), env);
      const secret = await user.loginOrCreateViaGatekeeper(principal.email, true, principal);
      const legacy = await user.loginOrCreateViaGatekeeper(principal.email, true);
      expect(await verifier.verify(`${principal.email}:${secret}`)).toEqual(principal);
      expect(await verifier.verify(`${principal.email}:${legacy}`)).toBeNull();
      const storage = makeUserStorage(state.storage);
      storage.sessions.delete(await hashSecret(Uint8Array.fromBase64(secret!)));
      expect(await verifier.verify(`${principal.email}:${secret}`)).toBeNull();
    });
  });
  it('rejects malformed and unknown tokens, even when authentication would otherwise accept them', async () => {
    await runInDurableObject(env.TEST_USER.getByName(principal.email), async (user, state) => {
      const verifier = new SubscriptionSetupSession(createExecutionContext(), env);
      const secret = await user.loginOrCreateViaGatekeeper(principal.email, true, principal);
      const token = `${principal.email}:${secret}`;
      for (const malformed of ['', 'x'.repeat(300), principal.email, `${token}:extra`, `${principal.email}:bad`,
        ` ${token}`, token.replace('owner@', 'OWNER@'), token.replace('owner@', 'own:er@'), token.replace(/=$/, ''),
        `${principal.email}:${new Uint8Array(32).toBase64()}`]) {
        expect(await verifier.verify(malformed)).toBeNull();
      }
    });
  });
  it('rejects stored principal/token email disagreement and malformed provenance', async () => {
    await runInDurableObject(env.TEST_USER.getByName(principal.email), async (user, state) => {
      const secret = await user.loginOrCreateViaGatekeeper(principal.email, true, principal);
      const verifier = new SubscriptionSetupSession(createExecutionContext(), env);
      const storage = makeUserStorage(state.storage);
      const tokenId = await hashSecret(Uint8Array.fromBase64(secret!));
      expect(await verifier.verify(`${principal.email}:${secret}`)).toEqual(principal);
      for (const candidate of [{ ...principal, email: 'other@example.invalid' }, { ...principal, subject: '' }, { ...principal, issuer: 'http://identity.example.invalid' }]) {
        storage.sessions.put({ tokenId, created: new Date(), principal: candidate });
        expect(await verifier.verify(`${principal.email}:${secret}`)).toBeNull();
      }
      storage.sessions.put({ tokenId, created: new Date(), principal });
      expect(await verifier.verify(`${principal.email}:${secret}`)).toEqual(principal);
    });
  });
  it('exports a named service entrypoint and adds no public HTTP route', async () => {
    expect(typeof (await import('../src/server')).SubscriptionSetupSession).toBe('function');
    const ctx = createExecutionContext();
    for (const path of ['/api/subscription-session', '/gatekeeper/subscription-session']) {
      expect((await server.fetch(new Request(`https://fixture.invalid${path}`, { method: 'POST' }), env, ctx)).status).toBe(404);
    }
    await waitOnExecutionContext(ctx);
  });
});
