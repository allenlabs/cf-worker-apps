import { beforeEach, describe, expect, it } from 'vitest';
import { host } from '~/host';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { type CurrentUser } from '@allenlabs/pm-core/server/auth';
import { createIssueImpl } from '@allenlabs/pm-core/server/issues';
import {
  createLabelImpl,
  deleteLabelImpl,
  labelsByIssueImpl,
  listIssueLabelsImpl,
  listLabelsImpl,
  setIssueLabelsImpl,
} from '~/server/labels';

let db: TestDB;
let alice: CurrentUser;
let projectId: number;

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
  const p = await insertProject(db);
  projectId = p.id;
});

async function makeIssue(subject = 'i') {
  return createIssueImpl(db, alice, {
    projectId,
    trackerId: 1,
    subject,
    description: '',
    doneRatio: 0,
  }, host);
}

describe('createLabelImpl / listLabelsImpl', () => {
  it('creates a label with the default color and lists it', async () => {
    const l = await createLabelImpl(db, { projectId, name: 'backend' });
    expect(l.color).toBe('#6b7280');
    const list = await listLabelsImpl(db, projectId);
    expect(list.map((x) => x.name)).toEqual(['backend']);
  });

  it('honours an explicit color and trims the name', async () => {
    const l = await createLabelImpl(db, { projectId, name: '  urgent  ', color: '#ff0000' });
    expect(l.name).toBe('urgent');
    expect(l.color).toBe('#ff0000');
  });

  it('rejects a duplicate name within the project', async () => {
    await createLabelImpl(db, { projectId, name: 'dup' });
    await expect(createLabelImpl(db, { projectId, name: 'dup' })).rejects.toThrow(/already exists/);
  });
});

describe('deleteLabelImpl', () => {
  it('removes the label', async () => {
    const l = await createLabelImpl(db, { projectId, name: 'temp' });
    await deleteLabelImpl(db, l.id);
    expect(await listLabelsImpl(db, projectId)).toEqual([]);
  });
});

describe('setIssueLabelsImpl / listIssueLabelsImpl', () => {
  it('assigns labels to an issue and replaces on the next call', async () => {
    const issue = await makeIssue();
    const a = await createLabelImpl(db, { projectId, name: 'a' });
    const b = await createLabelImpl(db, { projectId, name: 'b' });
    const c = await createLabelImpl(db, { projectId, name: 'c' });

    await setIssueLabelsImpl(db, issue.id, [a.id, b.id, b.id]); // dedups
    expect((await listIssueLabelsImpl(db, issue.id)).map((l) => l.name)).toEqual(['a', 'b']);

    await setIssueLabelsImpl(db, issue.id, [c.id]); // replaces
    expect((await listIssueLabelsImpl(db, issue.id)).map((l) => l.name)).toEqual(['c']);

    await setIssueLabelsImpl(db, issue.id, []); // clears
    expect(await listIssueLabelsImpl(db, issue.id)).toEqual([]);
  });

  it('drops label ids that belong to another project', async () => {
    const issue = await makeIssue();
    const other = await insertProject(db, { identifier: 'other', key: 'OTH' });
    const foreign = await createLabelImpl(db, { projectId: other.id, name: 'foreign' });
    await setIssueLabelsImpl(db, issue.id, [foreign.id]);
    expect(await listIssueLabelsImpl(db, issue.id)).toEqual([]);
  });

  it('throws when the issue does not exist', async () => {
    await expect(setIssueLabelsImpl(db, 999999, [])).rejects.toThrow(/Issue not found/);
  });
});

describe('labelsByIssueImpl', () => {
  it('returns an empty map for no issue ids', async () => {
    const map = await labelsByIssueImpl(db, []);
    expect(map.size).toBe(0);
  });

  it('groups labels per issue', async () => {
    const i1 = await makeIssue('one');
    const i2 = await makeIssue('two');
    const a = await createLabelImpl(db, { projectId, name: 'a' });
    const b = await createLabelImpl(db, { projectId, name: 'b' });
    await setIssueLabelsImpl(db, i1.id, [a.id, b.id]);
    await setIssueLabelsImpl(db, i2.id, [a.id]);

    const map = await labelsByIssueImpl(db, [i1.id, i2.id]);
    expect(map.get(i1.id)?.map((l) => l.name)).toEqual(['a', 'b']);
    expect(map.get(i2.id)?.map((l) => l.name)).toEqual(['a']);
  });
});

describe('createIssueImpl with labelIds', () => {
  it('assigns the given labels on creation', async () => {
    const a = await createLabelImpl(db, { projectId, name: 'a' });
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'labeled',
      description: '',
      doneRatio: 0,
      labelIds: [a.id],
    }, host);
    expect((await listIssueLabelsImpl(db, issue.id)).map((l) => l.name)).toEqual(['a']);
  });
});
