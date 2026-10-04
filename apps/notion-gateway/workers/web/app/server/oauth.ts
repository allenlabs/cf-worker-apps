// OAuth start + callback server-side logic.
//
// The /oauth/start route validates the consumer-app HMAC sig over
// `${app_client_id}\n${app_resource}\n${return_to}`, persists an
// `oauth_state` row, and redirects to Notion.
//
// The /oauth/callback route loads the row by `state`, exchanges the
// `code` for an access token, upserts the workspace, and redirects
// back to the consumer's `return_to`.

import { and, eq, lt } from 'drizzle-orm';
import { encrypt, deriveKey, signRequest, randomState } from '@shared/crypto';
import type { DB } from '@shared/db/client';
import { appClients, connections, oauthState, workspaces } from '@shared/db/schema';
import { exchangeOAuthCode } from '@shared/notion';
import type { Env } from '../lib/env';

const STATE_TTL_MS = 10 * 60 * 1000;

export interface StartInput {
  app: string;
  resource: string;
  return_to: string;
  sig: string;
}

export interface StartOutput {
  ok: true;
  redirectUrl: string;
}

export interface StartError {
  ok: false;
  status: number;
  message: string;
}

/**
 * Re-verify the consumer-app signature, validate `return_to`, mint a
 * fresh `state`, persist the OAuth row, and return the Notion authorize
 * URL.
 */
export async function startOAuthImpl(
  db: DB,
  env: Pick<Env, 'NOTION_CLIENT_ID' | 'NOTION_OAUTH_REDIRECT_URI'>,
  input: StartInput,
): Promise<StartOutput | StartError> {
  const client = await db.query.appClients.findFirst({
    where: eq(appClients.clientId, input.app),
  });
  if (!client) return { ok: false, status: 404, message: 'unknown app' };

  const payload = `${client.id}\n${input.resource}\n${input.return_to}`;
  const expectedSig = await signRequest(client.hmacSecret, payload, 0);
  if (expectedSig !== input.sig) {
    return { ok: false, status: 401, message: 'bad signature' };
  }

  if (!isAllowedReturnOrigin(input.return_to, client.allowedReturnOrigins)) {
    return { ok: false, status: 400, message: 'return_to origin not allowed' };
  }

  // Best-effort eviction of expired rows so the table doesn't grow
  // unbounded.  Cheap because of the `oauth_state_expires_at_idx` index.
  await db.delete(oauthState).where(lt(oauthState.expiresAt, new Date()));

  const state = randomState();
  await db.insert(oauthState).values({
    state,
    appClientId: client.id,
    appResource: input.resource,
    returnTo: input.return_to,
    expiresAt: new Date(Date.now() + STATE_TTL_MS),
  });

  const authorize = new URL('https://api.notion.com/v1/oauth/authorize');
  authorize.searchParams.set('client_id', env.NOTION_CLIENT_ID);
  authorize.searchParams.set('response_type', 'code');
  authorize.searchParams.set('owner', 'user');
  authorize.searchParams.set('redirect_uri', env.NOTION_OAUTH_REDIRECT_URI);
  authorize.searchParams.set('state', state);
  return { ok: true, redirectUrl: authorize.toString() };
}

export function isAllowedReturnOrigin(
  returnTo: string,
  allowed: string[],
): boolean {
  let target: URL;
  try {
    target = new URL(returnTo);
  } catch {
    return false;
  }
  for (const entry of allowed) {
    let candidate: URL;
    try {
      candidate = new URL(entry);
    } catch {
      continue;
    }
    if (candidate.origin === target.origin) return true;
  }
  return false;
}

// ---------- callback ----------

export interface CallbackInput {
  code?: string;
  state?: string;
  error?: string;
}

export interface CallbackOutput {
  ok: true;
  redirectUrl: string;
}

export interface CallbackError {
  ok: false;
  status: number;
  message: string;
}

export interface CallbackDeps {
  fetcher?: typeof fetch;
}

export async function callbackOAuthImpl(
  db: DB,
  env: Pick<
    Env,
    'NOTION_CLIENT_ID' | 'NOTION_CLIENT_SECRET' | 'NOTION_OAUTH_REDIRECT_URI' | 'WORKSPACE_TOKEN_KEY'
  >,
  input: CallbackInput,
  deps: CallbackDeps = {},
): Promise<CallbackOutput | CallbackError> {
  if (input.error) {
    return { ok: false, status: 400, message: `notion error: ${input.error}` };
  }
  if (!input.code || !input.state) {
    return { ok: false, status: 400, message: 'missing code/state' };
  }

  const row = await db.query.oauthState.findFirst({
    where: eq(oauthState.state, input.state),
  });
  if (!row) return { ok: false, status: 404, message: 'state not found' };
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(oauthState).where(eq(oauthState.state, input.state));
    return { ok: false, status: 410, message: 'state expired' };
  }

  const exchanged = await exchangeOAuthCode(
    env.NOTION_CLIENT_ID,
    env.NOTION_CLIENT_SECRET,
    input.code,
    env.NOTION_OAUTH_REDIRECT_URI,
    deps.fetcher,
  );

  const key = await deriveKey(env.WORKSPACE_TOKEN_KEY);
  const encryptedToken = await encrypt(key, exchanged.accessToken);

  const existing = await db.query.workspaces.findFirst({
    where: eq(workspaces.notionId, exchanged.botId),
  });
  let workspaceRow: typeof workspaces.$inferSelect | undefined;
  if (existing) {
    const [updated] = await db
      .update(workspaces)
      .set({
        workspaceId: exchanged.workspaceId,
        name: exchanged.workspaceName,
        icon: exchanged.workspaceIcon,
        ownerEmail: exchanged.ownerEmail,
        accessToken: encryptedToken,
        updatedAt: new Date(),
      })
      .where(eq(workspaces.notionId, exchanged.botId))
      .returning();
    workspaceRow = updated;
  } else {
    const [inserted] = await db
      .insert(workspaces)
      .values({
        notionId: exchanged.botId,
        workspaceId: exchanged.workspaceId,
        name: exchanged.workspaceName,
        icon: exchanged.workspaceIcon,
        ownerEmail: exchanged.ownerEmail,
        accessToken: encryptedToken,
      })
      .returning();
    workspaceRow = inserted;
  }
  /* v8 ignore next 3 — RETURNING always populates after a successful upsert. */
  if (!workspaceRow) {
    return { ok: false, status: 500, message: 'failed to persist workspace' };
  }

  await db.delete(oauthState).where(eq(oauthState.state, input.state));

  const url = new URL(row.returnTo);
  url.searchParams.set('notion_connected', '1');
  url.searchParams.set('notion_workspace_id', String(workspaceRow.id));
  return { ok: true, redirectUrl: url.toString() };
}

// ---------- admin listing ----------

export interface AdminWorkspaceRow {
  id: number;
  name: string;
  icon: string | null;
  ownerEmail: string | null;
  notionId: string;
  connections: Array<{
    id: number;
    appClient: string;
    appResource: string;
    databaseTitle: string;
    createdAt: string;
  }>;
}

export async function listAdminWorkspacesImpl(db: DB): Promise<AdminWorkspaceRow[]> {
  const wsRows = await db.select().from(workspaces).orderBy(workspaces.id);
  const allClients = await db.select().from(appClients);
  const appClientById = new Map<number, string>();
  for (const c of allClients) appClientById.set(c.id, c.clientId);

  const result: AdminWorkspaceRow[] = [];
  for (const ws of wsRows) {
    const rows = await db.query.connections.findMany({
      where: (c, { eq: eqq }) => eqq(c.workspaceId, ws.id),
    });
    result.push({
      id: ws.id,
      name: ws.name,
      icon: ws.icon,
      ownerEmail: ws.ownerEmail,
      notionId: ws.notionId,
      connections: rows.map((r) => ({
        id: r.id,
        /* v8 ignore next — FK guarantees the app client row exists. */
        appClient: appClientById.get(r.appClientId) ?? '?',
        appResource: r.appResource,
        databaseTitle: r.databaseTitle,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  }
  return result;
}

export async function disconnectWorkspaceImpl(db: DB, id: number): Promise<{ ok: true }> {
  await db.delete(workspaces).where(eq(workspaces.id, id));
  return { ok: true };
}

export async function disconnectConnectionImpl(
  db: DB,
  appClientId: number,
  appResource: string,
): Promise<{ ok: true }> {
  await db
    .delete(connections)
    .where(
      and(
        eq(connections.appClientId, appClientId),
        eq(connections.appResource, appResource),
      ),
    );
  return { ok: true };
}
