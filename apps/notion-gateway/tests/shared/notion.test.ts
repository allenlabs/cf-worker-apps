import { describe, expect, it, vi } from 'vitest';
import {
  NotionApiError,
  archivePage,
  createPage,
  exchangeOAuthCode,
  findUserByEmail,
  inspectDatabase,
  listDatabases,
  makeNotionClient,
  updatePage,
} from '@shared/notion';

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function fakeFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response | Promise<Response>,
): { fetcher: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(handler(input, init));
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('makeNotionClient', () => {
  it('uses globalThis.fetch when no fetch is provided', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    (globalThis as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
    try {
      const client = makeNotionClient('tok');
      await listDatabases(client);
      expect(spy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('sends Bearer auth + Notion-Version on every request', async () => {
    const { fetcher, calls } = fakeFetch(
      () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = makeNotionClient('my-token', { fetch: fetcher });
    await listDatabases(client);
    const headers = calls[0]!.init?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer my-token');
    expect(headers['Notion-Version']).toBe('2025-09-03');
  });

  it('honours a custom baseUrl when provided', async () => {
    const { fetcher, calls } = fakeFetch(
      () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = makeNotionClient('tok', {
      fetch: fetcher,
      baseUrl: 'https://example.test',
    });
    await listDatabases(client);
    expect(calls[0]!.url).toMatch(/^https:\/\/example\.test\/v1\//);
  });
});

describe('listDatabases', () => {
  it('flattens search results into {id,title} pairs', async () => {
    const { fetcher } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [
              { id: 'db1', title: [{ plain_text: 'Hello ' }, { plain_text: 'World' }] },
              { id: 'db2', title: [] },
              { id: 'db3' },
            ],
          }),
          { status: 200 },
        ),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    expect(await listDatabases(client)).toEqual([
      { id: 'db1', title: 'Hello World' },
      { id: 'db2', title: '(untitled)' },
      { id: 'db3', title: '(untitled)' },
    ]);
  });

  it('handles plain_text segments that are missing', async () => {
    const { fetcher } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [{ id: 'db1', title: [{}, { plain_text: 'Hi' }] }],
          }),
          { status: 200 },
        ),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    expect(await listDatabases(client)).toEqual([{ id: 'db1', title: 'Hi' }]);
  });

  it('falls back to "(untitled)" when every segment is empty', async () => {
    const { fetcher } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [{ id: 'db1', title: [{ plain_text: '   ' }, {}] }],
          }),
          { status: 200 },
        ),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    expect(await listDatabases(client)).toEqual([{ id: 'db1', title: '(untitled)' }]);
  });

  it('sends a search request filtered by object=database', async () => {
    const { fetcher, calls } = fakeFetch(
      () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    await listDatabases(client);
    expect(calls[0]!.url).toMatch(/\/search$/);
    const body = JSON.parse(String(calls[0]!.init?.body ?? '{}'));
    expect(body.filter).toEqual({ property: 'object', value: 'database' });
  });
});

describe('inspectDatabase', () => {
  it('returns the title + properties from databases.retrieve', async () => {
    const { fetcher, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            title: [{ plain_text: 'My DB' }],
            properties: {
              Title: { id: 'A', name: 'Title', type: 'title' },
              // Missing `name` should fall back to the property key.
              Status: { id: 'B', type: 'select' },
            },
          }),
          { status: 200 },
        ),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    const info = await inspectDatabase(client, 'db1');
    expect(info.title).toBe('My DB');
    expect(info.properties.Title).toEqual({ id: 'A', name: 'Title', type: 'title' });
    expect(info.properties.Status).toEqual({ id: 'B', name: 'Status', type: 'select' });
    expect(calls[0]!.url).toMatch(/\/databases\/db1$/);
  });

  it('tolerates a response with no properties block', async () => {
    const { fetcher } = fakeFetch(() => new Response(JSON.stringify({}), { status: 200 }));
    const client = makeNotionClient('tok', { fetch: fetcher });
    const info = await inspectDatabase(client, 'db1');
    expect(info.properties).toEqual({});
    expect(info.title).toBe('(untitled)');
  });
});

describe('createPage', () => {
  it('POSTs to /pages with the parent database id + properties', async () => {
    const { fetcher, calls } = fakeFetch(
      () => new Response(JSON.stringify({ id: 'page-1' }), { status: 200 }),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    const out = await createPage(client, 'db', { Title: { title: [] } });
    expect(out).toEqual({ id: 'page-1' });
    expect(calls[0]!.url).toMatch(/\/pages$/);
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      parent: { database_id: 'db' },
      properties: { Title: { title: [] } },
    });
  });
});

describe('updatePage / archivePage', () => {
  it('PATCHes the property update', async () => {
    const { fetcher, calls } = fakeFetch(
      () => new Response(JSON.stringify({ id: 'page-1' }), { status: 200 }),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    const out = await updatePage(client, 'page-1', { Title: { title: [] } });
    expect(out).toEqual({ id: 'page-1' });
    expect(calls[0]!.url).toMatch(/\/pages\/page-1$/);
    expect(calls[0]!.init?.method).toBe('PATCH');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      properties: { Title: { title: [] } },
    });
  });

  it('PATCHes with archived:true to soft-delete', async () => {
    const { fetcher, calls } = fakeFetch(
      () => new Response(JSON.stringify({ id: 'page-1' }), { status: 200 }),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    const out = await archivePage(client, 'page-1');
    expect(out).toEqual({ id: 'page-1' });
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ archived: true });
  });
});

describe('findUserByEmail', () => {
  it('matches case-insensitively', async () => {
    const { fetcher } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [
              { id: 'u1', type: 'bot' },
              { id: 'u2', type: 'person', person: { email: 'Allen@Example.com' } },
            ],
          }),
          { status: 200 },
        ),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    expect(await findUserByEmail(client, 'allen@example.com')).toBe('u2');
  });

  it('returns null on misses', async () => {
    const { fetcher } = fakeFetch(
      () => new Response(JSON.stringify({ results: [] }), { status: 200 }),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    expect(await findUserByEmail(client, 'x@x')).toBeNull();
  });

  it('returns null when the email field is missing', async () => {
    const { fetcher } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({
            results: [{ id: 'u1', type: 'person', person: {} }],
          }),
          { status: 200 },
        ),
    );
    const client = makeNotionClient('tok', { fetch: fetcher });
    expect(await findUserByEmail(client, 'a@b')).toBeNull();
  });

  it('swallows transport errors and returns null', async () => {
    // The SDK retries 5xx errors by default; disable retries via a
    // non-2xx-then-throw style fetch that just throws synchronously.
    const fetcher = (() => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const client = makeNotionClient('tok', { fetch: fetcher });
    expect(await findUserByEmail(client, 'a@b')).toBeNull();
  });
});

describe('exchangeOAuthCode', () => {
  it('builds the basic-auth request and returns the parsed response', async () => {
    const captured: { headers?: Record<string, string>; body?: string } = {};
    const { fetcher } = fakeFetch((_, init) => {
      captured.headers = init?.headers as Record<string, string>;
      captured.body = String(init?.body ?? '');
      return new Response(
        JSON.stringify({
          access_token: 'tok',
          bot_id: 'bot',
          workspace_id: 'ws',
          workspace_name: 'WS',
          workspace_icon: '🎯',
          owner: { user: { person: { email: 'me@x' } } },
        }),
        { status: 200 },
      );
    });
    const out = await exchangeOAuthCode('cid', 'csec', 'code-1', 'https://redir', fetcher);
    expect(out).toEqual({
      accessToken: 'tok',
      botId: 'bot',
      workspaceId: 'ws',
      workspaceName: 'WS',
      workspaceIcon: '🎯',
      ownerEmail: 'me@x',
    });
    expect(captured.headers!.Authorization).toMatch(/^Basic /);
    expect(JSON.parse(captured.body!)).toEqual({
      grant_type: 'authorization_code',
      code: 'code-1',
      redirect_uri: 'https://redir',
    });
  });

  it('fills in defaults for missing optional fields', async () => {
    const { fetcher } = fakeFetch(
      () =>
        new Response(
          JSON.stringify({ access_token: 't', bot_id: 'b', workspace_id: 'w' }),
          { status: 200 },
        ),
    );
    const out = await exchangeOAuthCode('cid', 'csec', 'code', 'r', fetcher);
    expect(out.workspaceName).toBe('(unnamed)');
    expect(out.workspaceIcon).toBeNull();
    expect(out.ownerEmail).toBeNull();
  });

  it('throws NotionApiError on non-2xx', async () => {
    const { fetcher } = fakeFetch(() => new Response('nope', { status: 400 }));
    await expect(
      exchangeOAuthCode('cid', 'csec', 'code', 'r', fetcher),
    ).rejects.toMatchObject({ status: 400 });
  });

  it('throws NotionApiError with the expected name', () => {
    const e = new NotionApiError(500, 'boom');
    expect(e.name).toBe('NotionApiError');
    expect(e.status).toBe(500);
  });

  it('exchangeOAuthCode uses global fetch by default', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: 't', bot_id: 'b', workspace_id: 'w' }),
          { status: 200 },
        ),
    );
    (globalThis as { fetch: typeof fetch }).fetch = spy as unknown as typeof fetch;
    try {
      await exchangeOAuthCode('cid', 'csec', 'c', 'r');
      expect(spy).toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });
});
