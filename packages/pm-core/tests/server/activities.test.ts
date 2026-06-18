import { beforeEach, describe, expect, it } from 'vitest';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../../src/testing/db';
import { listActivitiesImpl, logActivityImpl } from '../../src/server/activities';
import { findOrCreateSiteImpl } from '../../src/server/sites';

let db: TestDB;

beforeEach(async () => {
  db = await makeTestDb();
});

describe('logActivityImpl + listActivitiesImpl', () => {
  it('writes and reads activities back', async () => {
    const u = await insertUser(db);
    const p = await insertProject(db);
    await logActivityImpl(db, {
      projectId: p.id,
      userId: u.id,
      kind: 'project_created',
      refId: p.id,
      title: 'first',
    });
    const list = await listActivitiesImpl(db, { limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0]!.title).toBe('first');
    expect(list[0]!.projectName).toBe('Demo');
    expect(list[0]!.userLogin).toBe('tester');
    expect(list[0]!.kind).toBe('project_created');
    expect(list[0]!.body).toBe('');
  });

  it('handles null projectId (global event) and missing optionals', async () => {
    const u = await insertUser(db, { login: 'g' });
    await logActivityImpl(db, {
      projectId: null,
      userId: u.id,
      kind: 'issue_created',
      title: 'global',
    });
    const list = await listActivitiesImpl(db, {});
    expect(list[0]!.projectName).toBeNull();
    expect(list[0]!.body).toBe('');
  });

  it('filters by projectId', async () => {
    const u = await insertUser(db);
    const p1 = await insertProject(db, { identifier: 'p1' });
    const p2 = await insertProject(db, { identifier: 'p2' });
    await logActivityImpl(db, { projectId: p1.id, userId: u.id, kind: 'issue_created', title: 'a' });
    await logActivityImpl(db, { projectId: p2.id, userId: u.id, kind: 'issue_created', title: 'b' });
    const onlyP1 = await listActivitiesImpl(db, { projectId: p1.id });
    expect(onlyP1.map((a) => a.title)).toEqual(['a']);
  });

  it('respects the limit option', async () => {
    const u = await insertUser(db);
    const p = await insertProject(db);
    for (let i = 0; i < 5; i++) {
      await logActivityImpl(db, {
        projectId: p.id,
        userId: u.id,
        kind: 'comment_added',
        title: `n${i}`,
      });
    }
    expect(await listActivitiesImpl(db, { limit: 2 })).toHaveLength(2);
  });
});

describe('listActivitiesImpl site scoping (siteId arg)', () => {
  it('filters to activities whose project belongs to the site (and combines with projectId)', async () => {
    const u = await insertUser(db);
    const site = await findOrCreateSiteImpl(db, { slug: 'acme', name: 'Acme' });
    const inP = await insertProject(db, { identifier: 'in', siteId: site.id });
    const outP = await insertProject(db, { identifier: 'out' }); // siteless
    await logActivityImpl(db, { projectId: inP.id, userId: u.id, kind: 'project_created', title: 'in' });
    await logActivityImpl(db, { projectId: outP.id, userId: u.id, kind: 'project_created', title: 'out' });
    expect((await listActivitiesImpl(db, { siteId: site.id })).map((a) => a.title)).toEqual(['in']);
    // combined site + project filter
    expect(
      (await listActivitiesImpl(db, { siteId: site.id, projectId: inP.id })).map((a) => a.title),
    ).toEqual(['in']);
  });
});

