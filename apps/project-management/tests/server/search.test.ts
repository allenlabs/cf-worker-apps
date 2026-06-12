import { beforeEach, describe, expect, it } from 'vitest';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { issues } from '@allenlabs/pm-core/db/schema';
import { type CurrentUser } from '~/server/auth';
import { saveWikiPageImpl } from '~/server/wiki';
import { searchImpl, visibleProjectIdsImpl } from '~/server/search';

let db: TestDB;
let alice: CurrentUser;
let publicProjectId: number;
let privateProjectId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const u = await insertUser(db, { login: 'alice' });
  alice = {
    id: u.id,
    login: u.login,
    email: u.email,
    firstname: '',
    lastname: '',
    isAdmin: false,
    avatarUrl: null,
  };
  const pub = await insertProject(db, { identifier: 'pub', name: 'Pub', isPublic: true });
  publicProjectId = pub.id;
  const priv = await insertProject(db, { identifier: 'priv', name: 'Priv', isPublic: false });
  privateProjectId = priv.id;
  await db.insert(issues).values([
    {
      projectId: pub.id, number: 1, trackerId: 1, subject: 'pub issue rocket',
      description: '', statusId: 1, priorityId: 2, authorId: u.id,
    },
    {
      projectId: priv.id, number: 1, trackerId: 1, subject: 'priv issue rocket',
      description: '', statusId: 1, priorityId: 2, authorId: u.id,
    },
  ]);
  await saveWikiPageImpl(db, alice, {
    projectId: pub.id, slug: 'h', title: 'pub page', text: 'space rocket lore', comments: '',
  });
});

describe('visibleProjectIdsImpl', () => {
  it('returns only public projects to anonymous', async () => {
    const ids = await visibleProjectIdsImpl(db, null, null);
    expect(ids).toEqual([publicProjectId]);
  });

  it('returns all projects to admin', async () => {
    const ids = await visibleProjectIdsImpl(db, { ...alice, isAdmin: true }, null);
    expect(ids.sort()).toEqual([publicProjectId, privateProjectId].sort());
  });

  it('includes member-only projects for a regular user with view_project', async () => {
    const ids = await visibleProjectIdsImpl(db, alice, {
      userId: alice.id,
      isAdmin: false,
      permissionsByProject: { [privateProjectId]: new Set(['view_project']) },
    });
    expect(ids.sort()).toEqual([publicProjectId, privateProjectId].sort());
  });

  it('falls back to {} when ctx is null but a user is provided', async () => {
    const ids = await visibleProjectIdsImpl(db, alice, null);
    expect(ids).toEqual([publicProjectId]);
  });
});

describe('searchImpl', () => {
  it('returns matching issues and wiki pages from visible projects', async () => {
    const result = await searchImpl(db, null, null, { q: 'rocket' });
    expect(result.issues.map((i) => i.title)).toEqual(['pub issue rocket']);
    expect(result.wikis.map((w) => w.title)).toEqual(['pub page']);
  });

  it('respects the projectId filter', async () => {
    const result = await searchImpl(
      db,
      { ...alice, isAdmin: true },
      null,
      { q: 'rocket', projectId: privateProjectId },
    );
    expect(result.issues.map((i) => i.title)).toEqual(['priv issue rocket']);
    expect(result.wikis).toEqual([]);
  });

  it('returns empty result when no projects are visible', async () => {
    // Anonymous + everything private
    const fresh = await makeTestDb();
    const u = await insertUser(fresh);
    await insertProject(fresh, { identifier: 'p', isPublic: false });
    await fresh.insert(issues).values({
      projectId: 1, number: 1, trackerId: 1, subject: 'hidden',
      description: '', statusId: 1, priorityId: 2, authorId: u.id,
    });
    const r = await searchImpl(fresh, null, null, { q: 'hidden' });
    expect(r.issues).toEqual([]);
    expect(r.wikis).toEqual([]);
  });

  it('matches via stemming (rockets → rocket) — full-text, not substring', async () => {
    const result = await searchImpl(db, { ...alice, isAdmin: true }, null, { q: 'rockets' });
    expect(result.issues.map((i) => i.title).sort()).toEqual([
      'priv issue rocket',
      'pub issue rocket',
    ]);
    expect(result.wikis.map((w) => w.title)).toEqual(['pub page']);
  });
});
