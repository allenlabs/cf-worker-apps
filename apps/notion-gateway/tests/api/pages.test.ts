import { describe, expect, it } from 'vitest';
import { bytesToBase64, deriveKey, encrypt } from '@shared/crypto';
import { deletePageImpl, upsertPageImpl } from '../../workers/api/src/handlers/pages';
import { HandlerError } from '../../workers/api/src/handlers/connections';
import {
  insertAppClient,
  insertConnection,
  insertWorkspace,
  makeTestDb,
} from '../_setup/db';
import type { NotionMapping } from '@shared/types';

const KEY = bytesToBase64(new Uint8Array(32).fill(11));

async function seed() {
  const db = await makeTestDb();
  const key = await deriveKey(KEY);
  const accessToken = await encrypt(key, 'tok');
  const client = await insertAppClient(db);
  const workspace = await insertWorkspace(db, { accessToken });
  const mapping: NotionMapping = {
    fields: {
      subject: { propertyId: 'A', propertyName: 'Title', propertyType: 'title' },
      dueDate: { propertyId: 'B', propertyName: 'Due', propertyType: 'date' },
    },
  };
  const conn = await insertConnection(db, {
    appClientId: client.id,
    workspaceId: workspace.id,
    appResource: 'project/1',
    mapping,
  });
  return { db, client, workspace, conn };
}

interface Capture {
  url: string;
  method: string;
  body: unknown;
}

function makeFetcher(responses: Array<Response | (() => Response)>): {
  fetcher: typeof fetch;
  calls: Capture[];
} {
  const calls: Capture[] = [];
  let i = 0;
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const r = responses[i++] ?? new Response('{}', { status: 200 });
    const resolved = typeof r === 'function' ? r() : r;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(resolved);
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('upsertPageImpl', () => {
  it('creates a page on first call', async () => {
    const { db, client } = await seed();
    const { fetcher, calls } = makeFetcher([
      new Response(JSON.stringify({ id: 'page-1' }), { status: 200 }),
    ]);
    const out = await upsertPageImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      client.id,
      {
        app_resource: 'project/1',
        app_record: 'issue/1',
        fields: { subject: 'Hi', dueDate: '2026-06-01' },
      },
      { fetcher },
    );
    expect(out.created).toBe(true);
    expect(out.page_id).toBe('page-1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('https://api.notion.com/v1/pages');
  });

  it('updates the existing page on the second call', async () => {
    const { db, client } = await seed();
    const { fetcher } = makeFetcher([
      new Response(JSON.stringify({ id: 'page-7' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'page-7' }), { status: 200 }),
    ]);
    const first = await upsertPageImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      client.id,
      { app_resource: 'project/1', app_record: 'issue/9', fields: { subject: 'A' } },
      { fetcher },
    );
    const second = await upsertPageImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      client.id,
      { app_resource: 'project/1', app_record: 'issue/9', fields: { subject: 'B' } },
      { fetcher },
    );
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.page_id).toBe('page-7');
  });

  it('upsertPage 404s when the connection is missing', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db);
    await expect(
      upsertPageImpl(
        db,
        { WORKSPACE_TOKEN_KEY: KEY },
        client.id,
        { app_resource: 'unknown', app_record: 'x', fields: {} },
      ),
    ).rejects.toBeInstanceOf(HandlerError);
  });

  it('resolves people via the Notion users lookup', async () => {
    const db = await makeTestDb();
    const key = await deriveKey(KEY);
    const accessToken = await encrypt(key, 'tok');
    const client = await insertAppClient(db);
    const workspace = await insertWorkspace(db, { accessToken });
    const mapping: NotionMapping = {
      fields: {
        assignedTo: { propertyId: 'A', propertyName: 'Assignee', propertyType: 'people' },
      },
    };
    await insertConnection(db, {
      appClientId: client.id,
      workspaceId: workspace.id,
      appResource: 'project/1',
      mapping,
    });
    const { fetcher } = makeFetcher([
      // /users page lookup
      new Response(
        JSON.stringify({
          results: [{ id: 'user-1', type: 'person', person: { email: 'a@b' } }],
        }),
        { status: 200 },
      ),
      // page create
      new Response(JSON.stringify({ id: 'page-1' }), { status: 200 }),
    ]);
    const out = await upsertPageImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      client.id,
      {
        app_resource: 'project/1',
        app_record: 'issue/1',
        fields: { assignedTo: 'a@b' },
      },
      { fetcher },
    );
    expect(out.created).toBe(true);
  });
});

describe('deletePageImpl', () => {
  it('archives the page and clears the link', async () => {
    const { db, client } = await seed();
    const { fetcher, calls } = makeFetcher([
      new Response(JSON.stringify({ id: 'p1' }), { status: 200 }),
      new Response(JSON.stringify({ id: 'p1' }), { status: 200 }),
    ]);
    await upsertPageImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      client.id,
      { app_resource: 'project/1', app_record: 'issue/1', fields: { subject: 'A' } },
      { fetcher },
    );
    const out = await deletePageImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      client.id,
      { app_resource: 'project/1', app_record: 'issue/1' },
      { fetcher },
    );
    expect(out.archived).toBe(true);
    expect(calls[1]!.method).toBe('PATCH');
    expect(calls[1]!.body).toEqual({ archived: true });
  });

  it('is idempotent when no link exists', async () => {
    const { db, client } = await seed();
    const out = await deletePageImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      client.id,
      { app_resource: 'project/1', app_record: 'never-synced' },
    );
    expect(out).toEqual({ ok: true, archived: false });
  });

  it('deletePage 404s when the connection is missing', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db);
    await expect(
      deletePageImpl(
        db,
        { WORKSPACE_TOKEN_KEY: KEY },
        client.id,
        { app_resource: 'unknown', app_record: 'x' },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
