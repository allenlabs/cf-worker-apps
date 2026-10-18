import { createExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { newWebSocketRpcSession, type RpcStub } from 'capnweb';
import type { PublicApi } from '@gadgets/workshop-shared/api';
import { describe, expect, it } from 'vitest';
import server from '../src/server';
import { hashPresentedSecret, newSecretToken, PENDING_HANDOFF_LIFETIME_MS } from '../src/connect-handoff';
import { LOGIN_PENDING_LIFETIME_MS } from '../src/auth/login-flow';

async function connect(): Promise<RpcStub<PublicApi>> {
  const response = await server.fetch(new Request('https://workshop.example/api', {
    headers: { Upgrade: 'websocket' },
  }), { ...env, AUTH_GATEKEEPERS: 'oidc', GATEKEEPER_OIDC: {
    describe: async () => ({ providesAuth: true }),
    connectAccount: async () => ({ url: 'https://workshop.example/gatekeeper/oidc/fixture/start' }),
  } }, createExecutionContext());
  if (!response.webSocket) throw new Error('Expected a WebSocket response');
  response.webSocket.accept();
  return newWebSocketRpcSession<PublicApi>(response.webSocket);
}

async function pendingFor(nonce: string) {
  const hash = await hashPresentedSecret(nonce);
  if (hash === undefined) throw new Error('Expected a nonce');
  return exports.PendingLogin.getByName(hash);
}

async function rejection(operation: () => Promise<unknown>) {
  try { await operation(); return 'accepted'; } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
const EXPIRED = 'This sign-in attempt has expired. Please try again.';

describe('same-tab public login RPC', () => {
  it('requires a separate receive proof, ticket and nonce, and releases the session once', async () => {
    using api = await connect();
    const flow = await api.startGatekeeperLogin('oidc', 'redirect');
    expect(flow.mode).toBe('redirect');
    if (flow.mode !== 'redirect') throw new Error('Expected redirect mode');
    expect(flow.resumeSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(flow.resumeSecret).not.toBe(flow.nonce);
    const pending = await pendingFor(flow.nonce);
    const wrong = (await newSecretToken()).secret.toHex();
    for (const [nonce, proof] of [[flow.nonce, flow.nonce], [flow.nonce, wrong], [wrong, flow.resumeSecret],
      ['bad', flow.resumeSecret], [flow.nonce, 'bad'], [flow.nonce, flow.resumeSecret.toUpperCase()]]) {
      expect(await rejection(() => api.resumeGatekeeperLogin(nonce, proof))).toBe(EXPIRED);
    }
    using attempt = await api.resumeGatekeeperLogin(flow.nonce, flow.resumeSecret);
    expect(await attempt.receive()).toBeNull();
    const ticket = await newSecretToken();
    await pending.deliver('owner@example.invalid:fixture-session', ticket.hash);
    expect(await attempt.receive()).toBeNull();
    expect(await rejection(() => api.confirmLogin(wrong, flow.nonce))).toBe(EXPIRED);
    await api.confirmLogin(ticket.secret.toHex(), flow.nonce);
    expect(await attempt.receive()).toBe('owner@example.invalid:fixture-session');
    expect(await rejection(() => attempt.receive())).toBe(EXPIRED);
    expect(await rejection(() => api.resumeGatekeeperLogin(flow.nonce, flow.resumeSecret))).toBe(EXPIRED);
    await api.confirmLogin(ticket.secret.toHex(), flow.nonce);
    await runInDurableObject(pending, async (instance) => {
      expect(instance.ctx.storage.kv.get('resume')).toBeUndefined();
      expect(instance.ctx.storage.kv.get('result')).toMatchObject({ consumed: true, ticketHash: ticket.hash });
    });
  });

  it('stores only the resume hash and keeps the original pending and delivery time limits', async () => {
    using api = await connect();
    const flow = await api.startGatekeeperLogin('oidc', 'redirect');
    if (flow.mode !== 'redirect') throw new Error('Expected redirect mode');
    const pending = await pendingFor(flow.nonce);
    await runInDurableObject(pending, async (instance) => {
      const proof = instance.ctx.storage.kv.get<{ hash: string; expiresAt: number }>('resume');
      expect(proof?.hash).toBe(await hashPresentedSecret(flow.resumeSecret));
      expect(JSON.stringify([...instance.ctx.storage.kv.list()])).not.toContain(flow.resumeSecret);
      expect(await instance.ctx.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + LOGIN_PENDING_LIFETIME_MS);
    });
    const ticket = await newSecretToken();
    await pending.deliver('owner@example.invalid:fixture-session', ticket.hash);
    await runInDurableObject(pending, async (instance) => {
      const proof = instance.ctx.storage.kv.get<{ hash: string; expiresAt: number }>('resume');
      expect(proof?.expiresAt).toBeLessThanOrEqual(Date.now() + PENDING_HANDOFF_LIFETIME_MS);
      const result = instance.ctx.storage.kv.get<{ expiresAt: number }>('result');
      instance.ctx.storage.kv.put('result', { ...result, expiresAt: Date.now() - 1 });
    });
    expect(await rejection(() => api.resumeGatekeeperLogin(flow.nonce, flow.resumeSecret))).toBe(EXPIRED);
    await runInDurableObject(pending, async (instance) => {
      expect(instance.ctx.storage.kv.get('resume')).toBeUndefined();
      expect(await instance.ctx.storage.getAlarm()).toBeNull();
    });
  });

  it('cannot resume a popup flow and preserves the default popup capability', async () => {
    using api = await connect();
    const flow = await api.startGatekeeperLogin('oidc');
    expect(flow.mode).toBe('popup');
    if (flow.mode !== 'popup') throw new Error('Expected popup mode');
    using attempt = flow.attempt;
    expect(await attempt.receive()).toBeNull();
    expect(await rejection(() => api.resumeGatekeeperLogin(flow.nonce, flow.nonce))).toBe(EXPIRED);
    const ticket = await newSecretToken();
    await (await pendingFor(flow.nonce)).deliver('owner@example.invalid:popup-session', ticket.hash);
    await api.confirmLogin(ticket.secret.toHex(), flow.nonce);
    expect(await attempt.receive()).toBe('owner@example.invalid:popup-session');
  });

  it('clears proof on failure and alarm, and denies attempts that never began', async () => {
    using api = await connect();
    for (const action of ['fail', 'alarm']) {
      const flow = await api.startGatekeeperLogin('oidc', 'redirect');
      if (flow.mode !== 'redirect') throw new Error('Expected redirect mode');
      const pending = await pendingFor(flow.nonce);
      if (action === 'fail') await pending.fail('Sign-in was denied.');
      else await runInDurableObject(pending, instance => instance.alarm());
      const result = await rejection(() => api.resumeGatekeeperLogin(flow.nonce, flow.resumeSecret));
      expect(result).toBe(action === 'fail' ? 'Sign-in was denied.' : EXPIRED);
      await runInDurableObject(pending, async (instance) => {
        expect(instance.ctx.storage.kv.get('resume')).toBeUndefined();
      });
    }
    expect(await rejection(() => api.resumeGatekeeperLogin('a'.repeat(64), 'b'.repeat(64)))).toBe(EXPIRED);
  });
});
