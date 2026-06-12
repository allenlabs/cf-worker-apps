import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../../src/testing/db';
import { issueCategories } from '@allenlabs/pm-core/db/schema';
import {
  createCategoryImpl,
  deleteCategoryImpl,
  listCategoriesImpl,
} from '../../src/server/categories';

let db: TestDB;
let projectId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const p = await insertProject(db);
  projectId = p.id;
});

describe('category impls', () => {
  it('create + list', async () => {
    await createCategoryImpl(db, { projectId, name: 'Frontend' });
    await createCategoryImpl(db, { projectId, name: 'Backend' });
    const cats = await listCategoriesImpl(db, projectId);
    expect(cats.map((c) => c.name).sort()).toEqual(['Backend', 'Frontend']);
  });

  it('create with default assignee', async () => {
    const u = await insertUser(db);
    const c = await createCategoryImpl(db, {
      projectId,
      name: 'Triage',
      assignedToId: u.id,
    });
    if (!c) throw new Error('createCategoryImpl returned no row');
    expect(c.assignedToId).toBe(u.id);
  });

  it('handles missing assignedToId as null', async () => {
    const c = await createCategoryImpl(db, { projectId, name: 'C' });
    if (!c) throw new Error('createCategoryImpl returned no row');
    expect(c.assignedToId).toBeNull();
  });

  it('deleteCategoryImpl removes the row', async () => {
    const c = await createCategoryImpl(db, { projectId, name: 'x' });
    if (!c) throw new Error('createCategoryImpl returned no row');
    await deleteCategoryImpl(db, c.id);
    expect(
      await db.query.issueCategories.findFirst({ where: eq(issueCategories.id, c.id) }),
    ).toBeUndefined();
  });
});
