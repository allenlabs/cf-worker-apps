import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { wikiPages } from '@allenlabs/pm-core/db/schema';
import { type CurrentUser } from '~/server/auth';
import {
  deleteWikiPageImpl,
  getWikiPageImpl,
  listWikiPagesImpl,
  saveWikiPageImpl,
} from '~/server/wiki';

let db: TestDB;
let projectId: number;
let alice: CurrentUser;

beforeEach(async () => {
  db = await makeTestDb();
  const p = await insertProject(db);
  projectId = p.id;
  const u = await insertUser(db);
  alice = {
    id: u.id,
    login: u.login,
    email: u.email,
    firstname: '',
    lastname: '',
    isAdmin: false,
    avatarUrl: null,
  };
});

describe('wiki impls', () => {
  it('lazy-initialises a wiki shell when none exists', async () => {
    const { wiki, pages } = await listWikiPagesImpl(db, projectId);
    expect(wiki.projectId).toBe(projectId);
    expect(pages).toEqual([]);
  });

  it('creates a wiki row on-demand for a project that has none', async () => {
    // wipe the wiki row that insertProject() left behind
    const { wikis: wikisTable } = await import('@allenlabs/pm-core/db/schema');
    const { eq: eqOp } = await import('drizzle-orm');
    await db.delete(wikisTable).where(eqOp(wikisTable.projectId, projectId));
    const { wiki } = await listWikiPagesImpl(db, projectId);
    expect(wiki.projectId).toBe(projectId);
  });

  it('saveWikiPageImpl creates a new page + first revision', async () => {
    const { page, revision } = await saveWikiPageImpl(db, alice, {
      projectId,
      slug: 'getting-started',
      title: 'Getting Started',
      text: '# Hello',
      comments: 'init',
    });
    expect(page.title).toBe('Getting Started');
    expect(revision.version).toBe(1);
    expect(page.currentRevisionId).toBe(revision.id);
  });

  it('saveWikiPageImpl increments revision version on subsequent edits', async () => {
    await saveWikiPageImpl(db, alice, {
      projectId, slug: 'g', title: 'G', text: 'v1', comments: '',
    });
    const second = await saveWikiPageImpl(db, alice, {
      projectId, slug: 'g', title: 'G v2', text: 'v2', comments: '',
    });
    expect(second.revision.version).toBe(2);
    expect(second.page.title).toBe('G v2');
  });

  it('saveWikiPageImpl falls back to slugified title when no slug given', async () => {
    const { page } = await saveWikiPageImpl(db, alice, {
      projectId, slug: '', title: 'Hello World', text: 'x', comments: '',
    });
    expect(page.slug).toBe('hello-world');
  });

  it('getWikiPageImpl returns null page when slug is unknown', async () => {
    const r = await getWikiPageImpl(db, projectId, 'nope');
    expect(r.page).toBeNull();
    expect(r.revision).toBeNull();
    expect(r.revisions).toEqual([]);
  });

  it('getWikiPageImpl returns null revision when page has no currentRevisionId', async () => {
    const { wikiPages, wikis } = await import('@allenlabs/pm-core/db/schema');
    const { eq: eqOp } = await import('drizzle-orm');
    const wiki = (await db.query.wikis.findFirst({ where: eqOp(wikis.projectId, projectId) }))!;
    await db.insert(wikiPages).values({
      wikiId: wiki.id,
      slug: 'empty',
      title: 'Empty',
    });
    const r = await getWikiPageImpl(db, projectId, 'empty');
    expect(r.page).not.toBeNull();
    expect(r.revision).toBeNull();
  });

  it('getWikiPageImpl returns full revision history newest first', async () => {
    await saveWikiPageImpl(db, alice, { projectId, slug: 'h', title: 'H', text: 'v1', comments: 'c1' });
    await saveWikiPageImpl(db, alice, { projectId, slug: 'h', title: 'H', text: 'v2', comments: 'c2' });
    const r = await getWikiPageImpl(db, projectId, 'h');
    expect(r.revisions.map((x) => x.version)).toEqual([2, 1]);
    expect(r.revision!.text).toBe('v2');
  });

  it('deleteWikiPageImpl removes the page', async () => {
    const { page } = await saveWikiPageImpl(db, alice, {
      projectId, slug: 'g', title: 'G', text: 'x', comments: '',
    });
    await deleteWikiPageImpl(db, page.id);
    expect(await db.query.wikiPages.findFirst({ where: eq(wikiPages.id, page.id) })).toBeUndefined();
  });
});
