import { describe, expect, it } from 'vitest';
import { bytesToBase64, deriveKey, encrypt } from '@shared/crypto';
import { inspectDatabaseImpl, listDatabasesImpl } from '../../workers/api/src/handlers/databases';
import { HandlerError } from '../../workers/api/src/handlers/connections';
import { insertWorkspace, makeTestDb } from '../_setup/db';

const KEY = bytesToBase64(new Uint8Array(32).fill(7));

async function seedWorkspaceWithToken(db: Awaited<ReturnType<typeof makeTestDb>>) {
  const key = await deriveKey(KEY);
  const accessToken = await encrypt(key, 'notion-secret-token');
  return insertWorkspace(db, { accessToken });
}

function fakeFetch(handler: (input: RequestInfo | URL) => Response | Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL) => Promise.resolve(handler(input))) as typeof fetch;
}

describe('databases handlers', () => {
  it('listDatabases proxies to Notion with the decrypted token', async () => {
    const db = await makeTestDb();
    const ws = await seedWorkspaceWithToken(db);
    let seenAuth: string | null = null;
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      // The SDK emits the authorization header lowercase (see
      // @notionhq/client Client.js buildAuthHeader).
      seenAuth = headers.authorization ?? headers.Authorization ?? null;
      return Promise.resolve(
        new Response(
          JSON.stringify({ results: [{ id: 'db1', title: [{ plain_text: 'Hi' }] }] }),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const out = await listDatabasesImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      { workspace_id: ws.id },
      { fetcher },
    );
    expect(out.databases).toEqual([{ id: 'db1', title: 'Hi' }]);
    expect(seenAuth).toBe('Bearer notion-secret-token');
  });

  it('listDatabases 404s on an unknown workspace', async () => {
    const db = await makeTestDb();
    await expect(
      listDatabasesImpl(db, { WORKSPACE_TOKEN_KEY: KEY }, { workspace_id: 999 }),
    ).rejects.toBeInstanceOf(HandlerError);
  });

  it('inspectDatabase returns properties + suggested mapping', async () => {
    const db = await makeTestDb();
    const ws = await seedWorkspaceWithToken(db);
    const fetcher = fakeFetch(() =>
      new Response(
        JSON.stringify({
          title: [{ plain_text: 'DB' }],
          properties: {
            Title: { id: 'A', name: 'Title', type: 'title' },
            Due: { id: 'B', name: 'Due', type: 'date' },
          },
        }),
        { status: 200 },
      ),
    );
    const out = await inspectDatabaseImpl(
      db,
      { WORKSPACE_TOKEN_KEY: KEY },
      { workspace_id: ws.id, database_id: 'db1' },
      { fetcher },
    );
    expect(out.database.title).toBe('DB');
    expect(out.suggested.fields.subject?.propertyName).toBe('Title');
    // suggested_mapping is the new documented key; it must mirror
    // `suggested` so PM/MyPanel can rely on a single source.
    expect(out.suggested_mapping).toBe(out.suggested);
    expect(out.suggested_mapping.fields.subject?.propertyName).toBe('Title');
  });

  it('inspectDatabase 404s on an unknown workspace', async () => {
    const db = await makeTestDb();
    await expect(
      inspectDatabaseImpl(
        db,
        { WORKSPACE_TOKEN_KEY: KEY },
        { workspace_id: 999, database_id: 'x' },
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
