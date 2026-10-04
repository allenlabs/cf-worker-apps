// Thin wrapper around `@notionhq/client`.
//
// We use the official SDK (v5.22.0) for everything except the OAuth code
// exchange — the SDK doesn't expose the authorization_code grant, so that
// stays as a hand-rolled fetch.  The SDK is Workers-safe: it uses
// `globalThis.fetch` (configurable via the `fetch` option) and pulls in
// no Node-only deps.  Its default Notion-Version is `2025-09-03`, the
// same one we previously pinned by hand.

import { Client } from '@notionhq/client';
import type { NotionProperty } from './types';

type SDKFetch = NonNullable<ConstructorParameters<typeof Client>[0]>['fetch'];

export const NOTION_API_BASE = 'https://api.notion.com/v1';
export const NOTION_VERSION = '2025-09-03';

export class NotionApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'NotionApiError';
  }
}

export interface MakeNotionClientOptions {
  /**
   * Inject an explicit fetch implementation.  Tests use this to intercept
   * the HTTP layer instead of deep-mocking individual SDK methods; in
   * production the SDK falls back to `globalThis.fetch` automatically.
   *
   * Accepts the standard `typeof fetch` shape — internally narrowed to
   * the SDK's `SupportedFetch` type at the constructor boundary.
   */
  fetch?: typeof fetch;
  /** Override the upstream base URL — handy if a test wants to assert pathing. */
  baseUrl?: string;
}

/**
 * Build a Notion client bound to a single workspace's access token.  The
 * SDK already retries 429/5xx and pins `Notion-Version` to 2025-09-03 so
 * callers don't have to.
 */
export function makeNotionClient(
  accessToken: string,
  opts: MakeNotionClientOptions = {},
): Client {
  const sdkFetch: SDKFetch = (opts.fetch ?? globalThis.fetch.bind(globalThis)) as SDKFetch;
  return new Client({
    auth: accessToken,
    fetch: sdkFetch,
    ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
  });
}

// ---------- helpers callers used to get for free from NotionClient ----------

interface RawRichText {
  plain_text?: string;
}

function extractTitle(parts: ReadonlyArray<RawRichText> | undefined): string {
  if (!parts || parts.length === 0) return '(untitled)';
  const t = parts.map((p) => p.plain_text ?? '').join('').trim();
  return t || '(untitled)';
}

/**
 * `client.search({ filter: { property: 'object', value: 'database' } })`
 * — list every Notion database the integration has been granted access
 * to in this workspace.  We flatten the SDK's `SearchResponse` results
 * into the gateway's `{ id, title }` view.
 */
export async function listDatabases(
  client: Client,
): Promise<Array<{ id: string; title: string }>> {
  // SDK 5.22's `SearchParameters.filter.value` is typed as `'page' |
  // 'data_source'` (databases became data sources in API 2025-09-03),
  // but the runtime API still accepts `'database'` for backwards-compat
  // and the gateway's consumers expect to see database-shaped rows.
  // Cast at the call boundary so the rest of the code stays typed.
  const res = await client.search({
    filter: { property: 'object', value: 'database' as 'page' },
  });
  return res.results.map((r) => {
    const row = r as { id: string; title?: ReadonlyArray<RawRichText> };
    return { id: row.id, title: extractTitle(row.title) };
  });
}

/**
 * `client.databases.retrieve({ database_id })` — fetch the database's
 * title + property schema.  The 2025-09-03 SDK response still carries
 * `properties` directly when the integration's token version is pinned
 * back to a version that returns them; we accept both the data-source
 * envelope and the legacy direct-properties shape so the gateway works
 * whichever the upstream chooses.
 */
export async function inspectDatabase(
  client: Client,
  databaseId: string,
): Promise<{ title: string; properties: Record<string, NotionProperty> }> {
  const raw = (await client.databases.retrieve({ database_id: databaseId })) as {
    title?: ReadonlyArray<RawRichText>;
    properties?: Record<string, { id: string; name?: string; type: string }>;
  };
  const properties: Record<string, NotionProperty> = {};
  for (const [name, p] of Object.entries(raw.properties ?? {})) {
    properties[name] = { id: p.id, name: p.name ?? name, type: p.type };
  }
  return { title: extractTitle(raw.title), properties };
}

/**
 * `client.pages.create({ parent: { database_id }, properties })` — wrap
 * the SDK's response into the `{ id }` shape the gateway's handlers
 * already pass around.
 */
export async function createPage(
  client: Client,
  databaseId: string,
  properties: Record<string, Record<string, unknown>>,
): Promise<{ id: string }> {
  const res = await client.pages.create({
    parent: { database_id: databaseId },
    // The SDK's CreatePageParameters.properties union is exhaustive but
    // expressed via discriminated unions per property type; the gateway
    // hands us pre-shaped per-type payloads from `buildPropertyValue`,
    // so a single cast at the boundary avoids reproducing the entire
    // union in this file.
    properties: properties as never,
  });
  return { id: res.id };
}

/**
 * `client.pages.update({ page_id, properties })` — update the property
 * values of an existing page without touching its content.
 */
export async function updatePage(
  client: Client,
  pageId: string,
  properties: Record<string, Record<string, unknown>>,
): Promise<{ id: string }> {
  const res = await client.pages.update({
    page_id: pageId,
    properties: properties as never,
  });
  return { id: res.id };
}

/**
 * `client.pages.update({ page_id, archived: true })` — soft-delete a
 * page.  The `archived` flag is deprecated in favour of `in_trash` for
 * API ≥ 2026-03-11, but both still work in 2025-09-03 (and the SDK
 * still types `archived` on `UpdatePageBodyParameters`).
 */
export async function archivePage(
  client: Client,
  pageId: string,
): Promise<{ id: string }> {
  const res = await client.pages.update({ page_id: pageId, archived: true });
  return { id: res.id };
}

/**
 * Walk one page (max 100 users) of `client.users.list` and return the
 * first person whose email matches case-insensitively.  Callers swallow
 * failures — when the lookup misses we fall back to writing the email
 * into a `rich_text` property.
 */
export async function findUserByEmail(
  client: Client,
  email: string,
): Promise<string | null> {
  try {
    const res = await client.users.list({ page_size: 100 });
    const target = email.toLowerCase();
    const hit = res.results.find((u) => {
      if (u.type !== 'person') return false;
      const personEmail = (u as { person?: { email?: string } }).person?.email;
      return typeof personEmail === 'string' && personEmail.toLowerCase() === target;
    });
    return hit?.id ?? null;
  } catch {
    return null;
  }
}

// ---------- OAuth token exchange ----------

export interface OAuthExchangeResult {
  accessToken: string;
  botId: string;
  workspaceId: string;
  workspaceName: string;
  workspaceIcon: string | null;
  ownerEmail: string | null;
}

/**
 * Exchange a one-time `code` from Notion's authorize redirect for a
 * long-lived `access_token` bound to a workspace.  Kept as a tiny
 * hand-rolled fetch because the SDK doesn't expose the
 * `authorization_code` grant (the SDK's `oauth.token` shape requires a
 * client_id/client_secret object plus a token-type discriminator and
 * doesn't surface `bot_id`/`workspace_*` cleanly).  Notion uses HTTP
 * Basic auth here — the client_id:client_secret pair is base64-encoded
 * in the Authorization header rather than passed as form fields.
 */
export async function exchangeOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  fetcher: typeof fetch = fetch,
): Promise<OAuthExchangeResult> {
  const basic = btoa(`${clientId}:${clientSecret}`);
  const res = await fetcher(`${NOTION_API_BASE}/oauth/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Notion-Version': NOTION_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    /* v8 ignore next — defensive .catch for malformed bodies. */
    const text = await res.text().catch(() => '');
    throw new NotionApiError(res.status, `Notion oauth ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    bot_id: string;
    workspace_id: string;
    workspace_name?: string;
    workspace_icon?: string | null;
    owner?: { user?: { person?: { email?: string } } };
  };
  return {
    accessToken: data.access_token,
    botId: data.bot_id,
    workspaceId: data.workspace_id,
    workspaceName: data.workspace_name ?? '(unnamed)',
    workspaceIcon: data.workspace_icon ?? null,
    ownerEmail: data.owner?.user?.person?.email ?? null,
  };
}
