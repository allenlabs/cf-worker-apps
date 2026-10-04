import { describe, expect, it } from 'vitest';
import {
  HandlerError,
  deleteConnectionImpl,
  getConnectionImpl,
  listConnectionsImpl,
  upsertConnectionImpl,
} from '../../workers/api/src/handlers/connections';
import { insertAppClient, insertConnection, insertWorkspace, makeTestDb } from '../_setup/db';

describe('connection handlers', () => {
  it('returns null for an unknown app_resource', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db);
    const out = await getConnectionImpl(db, client.id, { app_resource: 'nope' });
    expect(out.connection).toBeNull();
  });

  it('upsert -> get -> list -> delete round trip', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db);
    const workspace = await insertWorkspace(db);

    const upsert = await upsertConnectionImpl(db, client.id, {
      app_resource: 'project/1',
      workspace_id: workspace.id,
      database_id: 'db1',
      database_title: 'My DB',
      mapping: { fields: {} },
    });
    expect(upsert.connection.workspace_name).toBe(workspace.name);
    expect(upsert.connection.database_id).toBe('db1');

    const got = await getConnectionImpl(db, client.id, { app_resource: 'project/1' });
    expect(got.connection?.id).toBe(upsert.connection.id);

    const list = await listConnectionsImpl(db, client.id);
    expect(list.connections).toHaveLength(1);

    await deleteConnectionImpl(db, client.id, { app_resource: 'project/1' });
    const after = await getConnectionImpl(db, client.id, { app_resource: 'project/1' });
    expect(after.connection).toBeNull();
  });

  it('upsert without workspace_id uses the existing row', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db);
    const workspace = await insertWorkspace(db);
    await insertConnection(db, {
      appClientId: client.id,
      workspaceId: workspace.id,
      appResource: 'project/1',
    });
    const out = await upsertConnectionImpl(db, client.id, {
      app_resource: 'project/1',
      database_id: 'new-db',
      database_title: 'New',
      mapping: { fields: {} },
    });
    expect(out.connection.database_id).toBe('new-db');
    expect(out.connection.workspace_id).toBe(workspace.id);
  });

  it('upsert without workspace_id and no existing row errors', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db);
    await expect(
      upsertConnectionImpl(db, client.id, {
        app_resource: 'project/1',
        database_id: 'db1',
        database_title: 'My DB',
        mapping: { fields: {} },
      }),
    ).rejects.toBeInstanceOf(HandlerError);
  });

  it('upsert with an unknown workspace_id errors', async () => {
    const db = await makeTestDb();
    const client = await insertAppClient(db);
    await expect(
      upsertConnectionImpl(db, client.id, {
        app_resource: 'project/1',
        workspace_id: 9999,
        database_id: 'db1',
        database_title: 'X',
        mapping: { fields: {} },
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('HandlerError carries status + name', () => {
    const e = new HandlerError(404, 'gone');
    expect(e.name).toBe('HandlerError');
    expect(e.status).toBe(404);
    expect(e.message).toBe('gone');
  });
});
