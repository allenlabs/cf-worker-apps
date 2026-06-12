import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../../src/testing/db';
import { issues, versions } from '@allenlabs/pm-core/db/schema';
import {
  createVersionImpl,
  deleteVersionImpl,
  listVersionsImpl,
  updateVersionImpl,
} from '../../src/server/versions';

let db: TestDB;
let projectId: number;
let authorId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const p = await insertProject(db);
  projectId = p.id;
  const u = await insertUser(db);
  authorId = u.id;
});

describe('version impls', () => {
  it('createVersionImpl inserts with defaults', async () => {
    const v = await createVersionImpl(db, {
      projectId,
      name: '1.0',
      description: '',
      sharing: 'none',
    });
    if (!v) throw new Error('createVersionImpl returned no row');
    expect(v.name).toBe('1.0');
    expect(v.status).toBe('open');
    expect(v.sharing).toBe('none');
  });

  it('listVersionsImpl computes progress from linked issues', async () => {
    const v = await createVersionImpl(db, {
      projectId,
      name: '1.0',
      description: '',
      sharing: 'none',
    });
    if (!v) throw new Error('createVersionImpl returned no row');
    await db.insert(issues).values([
      {
        projectId,
        number: 1,
        trackerId: 1,
        subject: 'open1',
        description: '',
        statusId: 1,
        priorityId: 2,
        authorId,
        fixedVersionId: v.id,
      },
      {
        projectId,
        number: 2,
        trackerId: 1,
        subject: 'open2',
        description: '',
        statusId: 1,
        priorityId: 2,
        authorId,
        fixedVersionId: v.id,
      },
      {
        projectId,
        number: 3,
        trackerId: 1,
        subject: 'closed',
        description: '',
        statusId: 5, // Closed
        priorityId: 2,
        authorId,
        fixedVersionId: v.id,
      },
    ]);
    const list = await listVersionsImpl(db, projectId);
    expect(list).toHaveLength(1);
    expect(list[0]!.totalIssues).toBe(3);
    expect(list[0]!.closedIssues).toBe(1);
    expect(list[0]!.percent).toBe(33);
  });

  it('percent stays 0 when no issues are assigned', async () => {
    await createVersionImpl(db, { projectId, name: 'empty', description: '', sharing: 'none' });
    const list = await listVersionsImpl(db, projectId);
    expect(list[0]!.percent).toBe(0);
  });

  it('updateVersionImpl mutates status / dueDate', async () => {
    const v = await createVersionImpl(db, { projectId, name: 'x', description: '', sharing: 'none' });
    if (!v) throw new Error('createVersionImpl returned no row');
    await updateVersionImpl(db, {
      id: v.id,
      projectId,
      name: 'renamed',
      description: 'd',
      dueDate: '2026-12-31',
      status: 'closed',
    });
    const out = await db.query.versions.findFirst({ where: eq(versions.id, v.id) });
    expect(out!.name).toBe('renamed');
    expect(out!.status).toBe('closed');
    expect(out!.dueDate).toBe('2026-12-31');
  });

  it('deleteVersionImpl removes the row', async () => {
    const v = await createVersionImpl(db, { projectId, name: 'x', description: '', sharing: 'none' });
    if (!v) throw new Error('createVersionImpl returned no row');
    await deleteVersionImpl(db, v.id);
    expect(await db.query.versions.findFirst({ where: eq(versions.id, v.id) })).toBeUndefined();
  });
});
