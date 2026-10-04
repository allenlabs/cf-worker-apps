import { describe, expect, it } from 'vitest';
import { listWorkspacesImpl } from '../../workers/api/src/handlers/workspaces';
import { insertWorkspace, makeTestDb } from '../_setup/db';

describe('listWorkspacesImpl', () => {
  it('returns rows mapped to the wire shape', async () => {
    const db = await makeTestDb();
    const a = await insertWorkspace(db, {
      name: 'A',
      notionId: 'a',
      ownerEmail: 'a@x',
    });
    const b = await insertWorkspace(db, {
      name: 'B',
      notionId: 'b',
      ownerEmail: null,
    });
    const out = await listWorkspacesImpl(db);
    expect(out).toEqual([
      {
        id: a.id,
        notion_id: 'a',
        name: 'A',
        icon: null,
        owner_email: 'a@x',
      },
      {
        id: b.id,
        notion_id: 'b',
        name: 'B',
        icon: null,
        owner_email: null,
      },
    ]);
  });

  it('returns [] on an empty database', async () => {
    const db = await makeTestDb();
    expect(await listWorkspacesImpl(db)).toEqual([]);
  });
});
