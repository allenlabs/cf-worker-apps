import { describe, expect, it } from 'vitest';
import { bytesToBase64, decrypt, deriveKey, signRequest } from '@shared/crypto';
import { oauthState, workspaces } from '@shared/db/schema';
import {
  callbackOAuthImpl,
  disconnectConnectionImpl,
  disconnectWorkspaceImpl,
  isAllowedReturnOrigin,
  listAdminWorkspacesImpl,
  startOAuthImpl,
} from '../../workers/web/app/server/oauth';
import {
  insertAppClient,
  insertConnection,
  insertWorkspace,
  makeTestDb,
} from '../_setup/db';

const KEY = bytesToBase64(new Uint8Array(32).fill(3));

const ENV = {
  NOTION_CLIENT_ID: 'cid',
  NOTION_CLIENT_SECRET: 'csec',
  NOTION_OAUTH_REDIRECT_URI: 'https://notion.allen.company/oauth/callback',
  WORKSPACE_TOKEN_KEY: KEY,
};

async function signFor(clientId: number, resource: string, returnTo: string, secret: string): Promise<string> {
  return await signRequest(secret, `${clientId}\n${resource}\n${returnTo}`, 0);
}

describe('startOAuthImpl', () => {
  it('redirects to Notion and persists oauth_state', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db, {
      clientId: 'pm',
      hmacSecret: 'sec',
      allowedReturnOrigins: ['https://x.example'],
    });
    const sig = await signFor(client.id, 'project/1', 'https://x.example/cb', 'sec');
    const out = await startOAuthImpl(db, ENV, {
      app: 'pm',
      resource: 'project/1',
      return_to: 'https://x.example/cb',
      sig,
    });
    if (!out.ok) throw new Error('expected ok');
    const url = new URL(out.redirectUrl);
    expect(url.host).toBe('api.notion.com');
    expect(url.searchParams.get('client_id')).toBe('cid');
    const state = url.searchParams.get('state')!;
    const row = await db.query.oauthState.findFirst({
      where: (s, { eq }) => eq(s.state, state),
    });
    expect(row?.returnTo).toBe('https://x.example/cb');
  });

  it('404s on an unknown app', async () => {
    const db = await makeTestDb();
    const out = await startOAuthImpl(db, ENV, {
      app: 'mystery',
      resource: 'r',
      return_to: 'https://x.example/',
      sig: 'sig',
    });
    expect(out).toEqual({ ok: false, status: 404, message: 'unknown app' });
  });

  it('401s on a bad signature', async () => {
    const db = await makeTestDb();
    await insertAppClient(db, { clientId: 'pm', hmacSecret: 'sec' });
    const out = await startOAuthImpl(db, ENV, {
      app: 'pm',
      resource: 'r',
      return_to: 'https://x.example/',
      sig: 'AAAA',
    });
    expect(out).toMatchObject({ ok: false, status: 401 });
  });

  it('400s on a disallowed return_to origin', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db, {
      clientId: 'pm',
      hmacSecret: 'sec',
      allowedReturnOrigins: ['https://only.example'],
    });
    const sig = await signFor(client.id, 'r', 'https://attacker.example/', 'sec');
    const out = await startOAuthImpl(db, ENV, {
      app: 'pm',
      resource: 'r',
      return_to: 'https://attacker.example/',
      sig,
    });
    expect(out).toMatchObject({ ok: false, status: 400 });
  });

  it('evicts expired oauth_state rows', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db, {
      clientId: 'pm',
      hmacSecret: 'sec',
      allowedReturnOrigins: ['https://x.example'],
    });
    await db.insert(oauthState).values({
      state: 'expired-state',
      appClientId: client.id,
      appResource: 'r',
      returnTo: 'https://x.example/',
      expiresAt: new Date(Date.now() - 1000),
    });
    const sig = await signFor(client.id, 'r', 'https://x.example/cb', 'sec');
    await startOAuthImpl(db, ENV, {
      app: 'pm',
      resource: 'r',
      return_to: 'https://x.example/cb',
      sig,
    });
    const stillThere = await db.query.oauthState.findFirst({
      where: (s, { eq }) => eq(s.state, 'expired-state'),
    });
    expect(stillThere).toBeUndefined();
  });
});

describe('isAllowedReturnOrigin', () => {
  it('matches by origin', () => {
    expect(
      isAllowedReturnOrigin('https://x.example/back', ['https://x.example']),
    ).toBe(true);
  });

  it('rejects mismatched hosts', () => {
    expect(
      isAllowedReturnOrigin('https://attacker.example/', ['https://x.example']),
    ).toBe(false);
  });

  it('rejects malformed URLs', () => {
    expect(isAllowedReturnOrigin('not a url', ['https://x.example'])).toBe(false);
  });

  it('ignores malformed allowlist entries', () => {
    expect(
      isAllowedReturnOrigin('https://x.example/', ['~~bad~~', 'https://x.example']),
    ).toBe(true);
  });
});

describe('callbackOAuthImpl', () => {
  function tokenFetcher(): typeof fetch {
    return ((_, init?: RequestInit) => {
      void init;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            access_token: 'tok',
            bot_id: 'bot-1',
            workspace_id: 'ws-1',
            workspace_name: 'WS',
            owner: { user: { person: { email: 'a@b' } } },
          }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
  }

  async function seedState(opts: { expired?: boolean } = {}) {
    const db = await makeTestDb();
    const client = await insertAppClient(db, {
      clientId: 'pm',
      hmacSecret: 'sec',
      allowedReturnOrigins: ['https://x.example'],
    });
    await db.insert(oauthState).values({
      state: 'st1',
      appClientId: client.id,
      appResource: 'project/1',
      returnTo: 'https://x.example/back',
      expiresAt: opts.expired ? new Date(Date.now() - 1000) : new Date(Date.now() + 60_000),
    });
    return db;
  }

  it('exchanges code, encrypts token, redirects', async () => {
    const db = await seedState();
    const out = await callbackOAuthImpl(db, ENV, { code: 'c', state: 'st1' }, { fetcher: tokenFetcher() });
    if (!out.ok) throw new Error('expected ok');
    expect(out.redirectUrl).toContain('notion_connected=1');
    const wsRow = await db.query.workspaces.findFirst({
      where: (w, { eq }) => eq(w.notionId, 'bot-1'),
    });
    expect(wsRow?.name).toBe('WS');
    const key = await deriveKey(KEY);
    expect(await decrypt(key, wsRow!.accessToken)).toBe('tok');
    // state row is consumed
    const stRow = await db.query.oauthState.findFirst({
      where: (s, { eq }) => eq(s.state, 'st1'),
    });
    expect(stRow).toBeUndefined();
  });

  it('updates an existing workspace row on re-auth', async () => {
    const db = await seedState();
    await insertWorkspace(db, {
      notionId: 'bot-1',
      name: 'old',
      accessToken: 'old-ciphertext',
    });
    const out = await callbackOAuthImpl(db, ENV, { code: 'c', state: 'st1' }, { fetcher: tokenFetcher() });
    expect(out.ok).toBe(true);
    const row = await db.query.workspaces.findFirst({
      where: (w, { eq }) => eq(w.notionId, 'bot-1'),
    });
    expect(row?.name).toBe('WS');
  });

  it('400s with notion error param', async () => {
    const db = await makeTestDb();
    const out = await callbackOAuthImpl(db, ENV, { error: 'access_denied' });
    expect(out).toMatchObject({ ok: false, status: 400 });
  });

  it('400s on missing code/state', async () => {
    const db = await makeTestDb();
    const out = await callbackOAuthImpl(db, ENV, {});
    expect(out).toMatchObject({ ok: false, status: 400 });
  });

  it('404s on an unknown state', async () => {
    const db = await makeTestDb();
    const out = await callbackOAuthImpl(db, ENV, { code: 'c', state: 'nope' });
    expect(out).toMatchObject({ ok: false, status: 404 });
  });

  it('410s on an expired state and clears it', async () => {
    const db = await seedState({ expired: true });
    const out = await callbackOAuthImpl(db, ENV, { code: 'c', state: 'st1' });
    expect(out).toMatchObject({ ok: false, status: 410 });
    const row = await db.query.oauthState.findFirst({
      where: (s, { eq }) => eq(s.state, 'st1'),
    });
    expect(row).toBeUndefined();
  });
});

describe('admin helpers', () => {
  it('lists workspaces with their connections grouped by app', async () => {
    const db = await makeTestDb();
    const pm = await insertAppClient(db, { clientId: 'pm', hmacSecret: 's' });
    const ws = await insertWorkspace(db);
    await insertConnection(db, {
      appClientId: pm.id,
      workspaceId: ws.id,
      appResource: 'project/1',
      databaseTitle: 'Roadmap',
    });
    const rows = await listAdminWorkspacesImpl(db);
    expect(rows[0]!.connections[0]).toMatchObject({
      appClient: 'pm',
      appResource: 'project/1',
      databaseTitle: 'Roadmap',
    });
  });

  it('disconnects a workspace by id', async () => {
    const db = await makeTestDb();
    const ws = await insertWorkspace(db);
    await disconnectWorkspaceImpl(db, ws.id);
    const rows = await db.select().from(workspaces);
    expect(rows).toHaveLength(0);
  });

  it('disconnects a single connection', async () => {
    const db = await makeTestDb();
    const pm = await insertAppClient(db, { clientId: 'pm', hmacSecret: 's' });
    const ws = await insertWorkspace(db);
    await insertConnection(db, {
      appClientId: pm.id,
      workspaceId: ws.id,
      appResource: 'project/1',
    });
    await disconnectConnectionImpl(db, pm.id, 'project/1');
    const rows = await listAdminWorkspacesImpl(db);
    expect(rows[0]!.connections).toHaveLength(0);
  });
});
