import { beforeEach, describe, expect, it } from 'vitest';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { issueRelations } from '~/db/schema';
import { type CurrentUser } from '~/server/auth';
import { createIssueImpl } from '~/server/issues';
import {
  addRelationImpl,
  listPrecedesEdgesImpl,
  listRelationsImpl,
  removeRelationImpl,
} from '~/server/relations';

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

function makeIssue(subject: string, pid = projectId) {
  return createIssueImpl(db, alice, {
    projectId: pid,
    trackerId: 1,
    subject,
    description: '',
    doneRatio: 0,
  });
}

describe('addRelationImpl', () => {
  it('creates a relation between two issues in the same project', async () => {
    const a = await makeIssue('a');
    const b = await makeIssue('b');
    const rel = await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' });
    expect(rel.relationType).toBe('blocks');
  });

  it('rejects a self-relation', async () => {
    const a = await makeIssue('a');
    await expect(
      addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: a.id, type: 'relates' }),
    ).rejects.toThrow(/cannot relate to itself/);
  });

  it('rejects when an issue is missing', async () => {
    const a = await makeIssue('a');
    await expect(
      addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: 999999, type: 'relates' }),
    ).rejects.toThrow(/Issue not found/);
  });

  it('rejects a cross-project relation', async () => {
    const a = await makeIssue('a');
    const other = await insertProject(db, { identifier: 'other', key: 'OTH' });
    const b = await makeIssue('b', other.id);
    await expect(
      addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: b.id, type: 'relates' }),
    ).rejects.toThrow(/same project/);
  });

  it('rejects a duplicate relation', async () => {
    const a = await makeIssue('a');
    const b = await makeIssue('b');
    await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: b.id, type: 'relates' });
    await expect(
      addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: b.id, type: 'relates' }),
    ).rejects.toThrow(/already exists/);
  });
});

describe('removeRelationImpl', () => {
  it('deletes the relation', async () => {
    const a = await makeIssue('a');
    const b = await makeIssue('b');
    const rel = await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' });
    await removeRelationImpl(db, rel.id);
    expect(await listRelationsImpl(db, a.id)).toEqual([]);
  });
});

describe('listRelationsImpl', () => {
  it('shows the stored type for the source and the inverse for the target', async () => {
    const a = await makeIssue('a');
    const b = await makeIssue('b');
    await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: b.id, type: 'blocks' });

    const fromA = await listRelationsImpl(db, a.id);
    expect(fromA).toHaveLength(1);
    expect(fromA[0]!.type).toBe('blocks');
    expect(fromA[0]!.issueId).toBe(b.id);
    expect(fromA[0]!.number).toBe(b.number);

    const fromB = await listRelationsImpl(db, b.id);
    expect(fromB).toHaveLength(1);
    expect(fromB[0]!.type).toBe('blocked'); // inverse
    expect(fromB[0]!.issueId).toBe(a.id);
  });

  it('maps every inverse: relates/duplicates/precedes/copied_to', async () => {
    const a = await makeIssue('a');
    const b = await makeIssue('b');
    const c = await makeIssue('c');
    const d = await makeIssue('d');
    const e = await makeIssue('e');
    await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: b.id, type: 'relates' });
    await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: c.id, type: 'duplicates' });
    await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: d.id, type: 'precedes' });
    await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: e.id, type: 'copied_to' });

    const byTarget = (id: number) => (rels: { issueId: number; type: string }[]) =>
      rels.find((r) => r.issueId === id)?.type;

    expect(byTarget(a.id)(await listRelationsImpl(db, b.id))).toBe('relates');
    expect(byTarget(a.id)(await listRelationsImpl(db, c.id))).toBe('duplicated');
    expect(byTarget(a.id)(await listRelationsImpl(db, d.id))).toBe('follows');
    expect(byTarget(a.id)(await listRelationsImpl(db, e.id))).toBe('copied_from');
  });

  it('falls back to the raw type for an unknown stored relation', async () => {
    const a = await makeIssue('a');
    const b = await makeIssue('b');
    await db
      .insert(issueRelations)
      .values({ sourceIssueId: a.id, targetIssueId: b.id, relationType: 'mystery' });
    const fromB = await listRelationsImpl(db, b.id);
    expect(fromB[0]!.type).toBe('mystery');
  });
});

describe('listPrecedesEdgesImpl', () => {
  it('returns [] for a project with no issues', async () => {
    const empty = await insertProject(db, { identifier: 'empty', key: 'EMP' });
    expect(await listPrecedesEdgesImpl(db, empty.id)).toEqual([]);
  });

  it('returns only precedes edges', async () => {
    const a = await makeIssue('a');
    const b = await makeIssue('b');
    const c = await makeIssue('c');
    await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: b.id, type: 'precedes' });
    await addRelationImpl(db, { sourceIssueId: a.id, targetIssueId: c.id, type: 'blocks' });
    const edges = await listPrecedesEdgesImpl(db, projectId);
    expect(edges).toEqual([{ fromIssueId: a.id, toIssueId: b.id }]);
  });
});
