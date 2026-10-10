import { createExecutionContext, waitOnExecutionContext, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeUserStorage } from '../src/storage-schema/user-storage';
import { makeOverseerStorage } from '../src/storage-schema/overseer-storage';
import './test-worker';
import server from '../src/server';
import { SiteLaunchGateway } from '../src/site-launch';
import { LoginConnectCallbackImpl } from '../src/auth/login-flow';
import { hashPresentedSecret } from '../src/connect-handoff';
import { DEFAULT_ADMIN_CONFIG } from '../src/storage-schema/admin-settings-storage';
import { getSiteLaunchErrorCode, type PublicApi } from '@gadgets/workshop-shared/api';
import { newWebSocketRpcSession } from 'capnweb';
const issuer = 'https://identity.example.invalid';
const principal = { issuer, subject: 'subject-one', email: 'one@example.invalid' };
const other = { issuer, subject: 'subject-two', email: 'two@example.invalid' };
const site = { id: 'site-one', environment: 'production', displayName: 'Site One', timezone: 'Asia/Seoul' };
const parentOrigin = 'https://compass.example.invalid';
function deployment() { return { ...env, SITE_LAUNCH_ISSUER: issuer,
  SITE_LAUNCH_IDENTITIES: JSON.stringify([principal, other]), SITE_LAUNCH_PARENT_ORIGINS: JSON.stringify([parentOrigin]) }; }
async function withUser<T>(f: (user: any, state: DurableObjectState) => Promise<T>, actor = principal) {
  return runInDurableObject(env.TEST_USER.getByName(actor.email), async (user, state) => {
    const previous = user.env; user.env = deployment() as any;
    try { await user.loginOrCreateViaGatekeeper(actor.email, true, actor); return await f(user, state); }
    finally { user.env = previous; }
  });
}
async function issue(user: any, selected = site, actor = principal) {
  return user.issueSiteLaunch({ principal: actor, site: selected, parentOrigin });
}
describe('verified per-user site launch', () => {
  it('persists provenance per session without changing old sessions', async () => {
    await withUser(async user => {
      const old = await user.loginOrCreateViaGatekeeper(principal.email, true);
      const current = await user.loginOrCreateViaGatekeeper(principal.email, true, principal);
      expect(await user.authenticate(old)).toBeUndefined();
      expect(await user.authenticate(current)).toEqual(principal);
    });
  });
  it('requires a provider-verified session and does not consume a mismatched ticket', async () => {
    await withUser(async user => {
      const { ticket } = await issue(user);
      await expect(user.redeemSiteLaunch(ticket, undefined)).rejects.toThrow('site_launch_sign_in_required');
      await expect(user.redeemSiteLaunch(ticket, { ...principal, subject: 'impostor' })).rejects.toThrow('site_launch_invalid');
      const result = await user.redeemSiteLaunch(ticket, principal);
      expect(result.siteContext).toEqual(site);
      expect(result.workspaceId).toMatch(/^[a-f0-9]{64}$/);
      await expect(user.redeemSiteLaunch(ticket, principal)).rejects.toThrow('site_launch_invalid');
    });
  });
  it('rejects a ticket outside its owning user without spending it', async () => {
    const launch = await withUser(user => issue(user));
    await withUser(async user => { await expect(user.redeemSiteLaunch(launch.ticket, other)).rejects.toThrow('site_launch_invalid'); }, other);
    await withUser(async user => { expect((await user.redeemSiteLaunch(launch.ticket, principal)).siteContext).toEqual(site); });
  });
  it('stores only the hash and refuses expiry and malformed tokens', async () => {
    await withUser(async (user, state) => {
      const { ticket, expiresAt } = await issue(user);
      expect(expiresAt - Date.now()).toBeLessThanOrEqual(300_000);
      const storage = makeUserStorage(state.storage) as any;
      const pending = [...storage.pendingSiteLaunches.list()][0];
      expect(pending.ticketHash).not.toBe(ticket);
      expect(JSON.stringify(pending)).not.toContain(ticket);
      storage.pendingSiteLaunches.put({ ...pending, expiresAt: Date.now() - 1 });
      await expect(user.redeemSiteLaunch(ticket, principal)).rejects.toThrow('site_launch_expired');
      await expect(user.redeemSiteLaunch('bad-ticket', principal)).rejects.toThrow('site_launch_invalid');
    });
  });
  it('pins policy and parent origin and validates descriptor inputs', async () => {
    await withUser(async user => {
      for (const bad of [ { principal: { ...principal, subject: 'wrong' }, site, parentOrigin },
        { principal, site, parentOrigin: 'https://attacker.example.invalid' },
        { principal, site: { ...site, environment: 'unknown' }, parentOrigin },
        { principal, site: { ...site, timezone: 'invalid-timezone' }, parentOrigin },
        { principal, site: { ...site, id: '../another-site' }, parentOrigin } ]) {
        await expect(user.issueSiteLaunch(bad)).rejects.toThrow('site_launch_invalid');
      }
      const { ticket } = await issue(user); user.env = { ...user.env, SITE_LAUNCH_IDENTITIES: '[]' };
      await expect(user.redeemSiteLaunch(ticket, principal)).rejects.toThrow('site_launch_disabled');
    });
  });
  it('deduplicates concurrent launches and keeps sites/environments distinct', async () => {
    await withUser(async user => {
      const tickets = await Promise.all([issue(user), issue(user)]);
      const results = await Promise.all(tickets.map(t => user.redeemSiteLaunch(t.ticket, principal)));
      expect(results[0].workspaceId).toBe(results[1].workspaceId);
      const second = await issue(user, { ...site, id: 'site-two' });
      const stage = await issue(user, { ...site, environment: 'stg' });
      const secondResult = await user.redeemSiteLaunch(second.ticket, principal);
      const stageResult = await user.redeemSiteLaunch(stage.ticket, principal);
      expect(new Set([results[0].workspaceId, secondResult.workspaceId, stageResult.workspaceId]).size).toBe(3);
    });
  });
  it('initializes immutable owner-only context and does not bind or share resources', async () => {
    const result = await withUser(async user => user.redeemSiteLaunch((await issue(user)).ticket, principal));
    await runInDurableObject(env.TEST_OVERSEER.get(env.TEST_OVERSEER.idFromString(result.workspaceId)), async (overseer, state) => {
      expect(await (overseer as any).getSiteContext()).toEqual(site);
      const storage = makeOverseerStorage(state.storage);
      expect([...storage.gatekeepers.list()]).toHaveLength(0);
      expect([...storage.shareKeys.list()]).toHaveLength(0);
      expect([...storage.collaborators.list()]).toHaveLength(0);
      await expect((overseer as any).initializeSiteWorkspace('wrong-owner', site)).rejects.toThrow('site_launch_invalid');
      await expect((overseer as any).initializeSiteWorkspace(storage.ownerId.get(), { ...site, id: 'changed' })).rejects.toThrow('site_launch_invalid');
    });
  });
  it('reuses reservations after cross-DO init failure and deletes stale mappings', async () => {
    await withUser(async (user, state) => {
      const storage = makeUserStorage(state.storage) as any;
      const result = await user.redeemSiteLaunch((await issue(user)).ticket, principal);
      const saved = [...storage.siteWorkspaces.list()][0];
      expect(saved.workspaceId).toBe(result.workspaceId);
      // An issued fresh ticket reuses the persistent reservation even after the request ends.
      expect((await user.redeemSiteLaunch((await issue(user)).ticket, principal)).workspaceId).toBe(result.workspaceId);
      await user.deleteGadget(result.workspaceId);
      expect([...storage.siteWorkspaces.list()].some((r: any) => r.workspaceId === result.workspaceId)).toBe(false);
      expect((await user.redeemSiteLaunch((await issue(user)).ticket, principal)).workspaceId).not.toBe(result.workspaceId);
    });
  });
  it('keeps site workspaces private against explicit invitations and share links', async () => {
    const selected = { ...site, id: 'private-site' };
    const result = await withUser(async user => user.redeemSiteLaunch((await issue(user, selected)).ticket, principal));
    const ownerId = env.TEST_USER.idFromName(principal.email).toString();
    await runInDurableObject(env.TEST_OVERSEER.get(env.TEST_OVERSEER.idFromString(result.workspaceId)), async overseer => {
      const closed: any = Object.assign(() => {}, { [Symbol.dispose]: () => {} });
      closed.dup = () => closed;
      using view = await overseer.open(ownerId, principal.email, closed as any);
      await expect(view.createShareLink('build')).rejects.toThrow('site_launch_invalid');
      await expect(view.addCollaborator(other.email, 'build')).rejects.toThrow('site_launch_invalid');
      await expect(view.newShareLinkKey('unknown')).rejects.toThrow('site_launch_invalid');
      await expect(overseer.open(env.TEST_USER.idFromName(other.email).toString(), other.email, closed as any, 'arbitrary'))
        .rejects.toThrow('access');
    });
  });
  it('keeps reservations when initialization fails and retries with a fresh ticket', async () => {
    const selected = { ...site, id: 'retry-site' };
    const result = await withUser(async user => user.redeemSiteLaunch((await issue(user, selected)).ticket, principal));
    await runInDurableObject(env.TEST_OVERSEER.get(env.TEST_OVERSEER.idFromString(result.workspaceId)), async overseer => {
      overseer.initializeSiteWorkspace = async () => { throw Error('synthetic initialization failure'); };
      try {
        await withUser(async user => { await expect(user.redeemSiteLaunch((await issue(user, selected)).ticket, principal)).rejects.toThrow(); });
      } finally { delete (overseer as any).initializeSiteWorkspace; }
    });
    await withUser(async user => { expect((await user.redeemSiteLaunch((await issue(user, selected)).ticket, principal)).workspaceId).toBe(result.workspaceId); });
  });
  it('preserves safe error classification and session provenance through browser RPC', async () => {
    await withUser(async (user, state) => {
      const current = await user.loginOrCreateViaGatekeeper(principal.email, true, principal);
      const legacy = await user.loginOrCreateViaGatekeeper(principal.email, true);
      const ctx = createExecutionContext();
      const response = await server.fetch(new Request('https://fixture.invalid/api', { headers: { Upgrade: 'websocket' } }), deployment() as any, ctx);
      const socket = response.webSocket!; socket.accept();
      using api = newWebSocketRpcSession<PublicApi>(socket);
      await expect((api as any).issueSiteLaunch({ principal, site, parentOrigin })).rejects.toThrow();
      using old = await api.authenticate(`${principal.email}:${legacy}`);
      const launch = await issue(user, { ...site, id: 'browser-site' });
      let oldError;
      try { await old.redeemSiteLaunch(launch.ticket); } catch (e) { oldError = e; }
      expect(getSiteLaunchErrorCode(oldError)).toBe('site_launch_sign_in_required');
      using authenticated = await api.authenticate(`${principal.email}:${current}`);
      const result = await authenticated.redeemSiteLaunch(launch.ticket);
      expect(result.siteContext.id).toBe('browser-site');
      using workspace = await authenticated.openGadget(result.workspaceId);
      expect(await workspace.getSiteContext()).toEqual(result.siteContext);
      let replayError;
      try { await authenticated.redeemSiteLaunch(launch.ticket); } catch (e) { replayError = e; }
      expect(getSiteLaunchErrorCode(replayError)).toBe('site_launch_invalid');
      const expired = await issue(user, { ...site, id: 'expired-browser-site' });
      const storage = makeUserStorage(state.storage);
      const hash = (await hashPresentedSecret(expired.ticket))!;
      storage.pendingSiteLaunches.put({ ...storage.pendingSiteLaunches.get(hash)!, expiresAt: Date.now() - 1 });
      let expiredError;
      try { await authenticated.redeemSiteLaunch(expired.ticket); } catch (e) { expiredError = e; }
      expect(getSiteLaunchErrorCode(expiredError)).toBe('site_launch_expired');
      user.env = { ...user.env, SITE_LAUNCH_IDENTITIES: '[]' };
      let disabledError;
      try { await authenticated.redeemSiteLaunch('f'.repeat(64)); } catch (e) { disabledError = e; }
      expect(getSiteLaunchErrorCode(disabledError)).toBe('site_launch_disabled');

      await waitOnExecutionContext(ctx);
    });
  });

  it('issues only through the private gateway and never public HTTP', async () => {
    await withUser(async (user, state) => {
      const gateway = new SiteLaunchGateway(state as any, deployment() as any);
      const launch = await gateway.issueSiteLaunch({ principal, site: { ...site, id: 'gateway-site' }, parentOrigin });
      expect(launch.ticket).toMatch(/^[a-f0-9]{64}$/);
      expect((await user.redeemSiteLaunch(launch.ticket, principal)).siteContext.id).toBe('gateway-site');
      const ctx = createExecutionContext();
      expect((await server.fetch(new Request('https://fixture.invalid/api/site-launch', { method: 'POST' }), deployment() as any, ctx)).status).toBe(404);
      await waitOnExecutionContext(ctx);
    });
  });
  it('passes trusted OIDC provenance from the real login callback into the session', async () => {
    const pending = env.TEST_PENDING_LOGIN.getByName(`site-login-${crypto.randomUUID()}`);
    await pending.begin();
    let handoff: any;
    await withUser(async (user, state) => {
      Object.defineProperty(state, 'props', { configurable: true, value: { pendingId: pending.id.toString(), vendorId: 'oidc' } });
      const callback = new LoginConnectCallbackImpl(state as any, {
        ...deployment(), BLUEPRINTS: { get: async () => JSON.stringify(DEFAULT_ADMIN_CONFIG) },
      } as any);
      handoff = await callback.complete({ getAuthenticatedEmail: async () => principal.email,
        getAuthenticatedIdentity: async () => principal } as any);
    });
    await pending.confirm(handoff.ticket);
    const token = await pending.receive();
    expect(token).toMatch(/^one@example.invalid:/);
    await withUser(async user => { expect(await user.authenticate(token!.split(':')[1])).toEqual(principal); });
  });
  it('gives different users distinct workspaces for the same site', async () => {
    const one = await withUser(async user => user.redeemSiteLaunch((await issue(user)).ticket, principal));
    const two = await withUser(async user => user.redeemSiteLaunch((await issue(user, site, other)).ticket, other), other);
    expect(two.workspaceId).not.toBe(one.workspaceId);
    expect(two.siteContext).toEqual(one.siteContext);
  });
  it('consumes a ticket exactly once under concurrent redemption', async () => {
    await withUser(async user => {
      const { ticket } = await issue(user, { ...site, id: 'replay-race' });
      const results = await Promise.allSettled([user.redeemSiteLaunch(ticket, principal), user.redeemSiteLaunch(ticket, principal)]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const failure = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
      expect(getSiteLaunchErrorCode(failure.reason)).toBe('site_launch_invalid');
    });
  });

  it('fails closed for preview, port, and oversized runtime parent-origin policies', async () => {
    await withUser(async user => {
      for (const origins of [['https://preview.workers.dev'], ['https://compass.example.invalid:8443'],
        Array.from({ length: 11 }, (_, i) => `https://parent${i}.example.invalid`)]) {
        user.env = { ...deployment(), SITE_LAUNCH_PARENT_ORIGINS: JSON.stringify(origins) };
        await expect(issue(user)).rejects.toThrow('site_launch_disabled');
      }
    });
  });

});
