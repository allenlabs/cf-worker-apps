import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { issues } from '~/db/schema';
import { type CurrentUser } from '~/server/auth';
import { createIssueImpl, getIssueImpl, updateIssueImpl } from '~/server/issues';
import { assertValidParentImpl, rollupParentDoneRatioImpl } from '~/server/subtasks';

let db: TestDB;
let alice: CurrentUser;
let projectId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const u = await insertUser(db, { login: 'alice' });
  alice = { id: u.id, login: u.login, email: u.email, firstname: '', lastname: '', isAdmin: false, avatarUrl: null };
  projectId = (await insertProject(db)).id;
});

function mk(overrides: Partial<{ subject: string; doneRatio: number; parentId: number; projectId: number }> = {}) {
  return createIssueImpl(db, alice, {
    projectId: overrides.projectId ?? projectId,
    trackerId: 1,
    subject: overrides.subject ?? 's',
    description: '',
    doneRatio: overrides.doneRatio ?? 0,
    parentId: overrides.parentId,
  });
}

describe('assertValidParentImpl', () => {
  it('returns for a null parent (detach)', async () => {
    const a = await mk();
    await expect(assertValidParentImpl(db, a.id, null)).resolves.toBeUndefined();
  });

  it('rejects self-parenting', async () => {
    const a = await mk();
    await expect(assertValidParentImpl(db, a.id, a.id)).rejects.toThrow(/own parent/);
  });

  it('rejects when the child is missing', async () => {
    const p = await mk();
    await expect(assertValidParentImpl(db, 999999, p.id)).rejects.toThrow(/Issue not found/);
  });

  it('rejects when the parent is missing', async () => {
    const a = await mk();
    await expect(assertValidParentImpl(db, a.id, 999999)).rejects.toThrow(/Parent issue not found/);
  });

  it('rejects a cross-project parent', async () => {
    const a = await mk();
    const other = await insertProject(db, { identifier: 'other', key: 'OTH' });
    const b = await mk({ projectId: other.id });
    await expect(assertValidParentImpl(db, a.id, b.id)).rejects.toThrow(/same project/);
  });

  it('accepts a parent with no ancestors', async () => {
    const a = await mk();
    const b = await mk();
    await expect(assertValidParentImpl(db, a.id, b.id)).resolves.toBeUndefined();
  });

  it('accepts a deep ancestor chain', async () => {
    const gp = await mk();
    const p = await mk({ parentId: gp.id });
    const c = await mk();
    await expect(assertValidParentImpl(db, c.id, p.id)).resolves.toBeUndefined();
  });

  it('rejects a cycle (parenting under a descendant)', async () => {
    const a = await mk();
    const b = await mk({ parentId: a.id }); // b under a
    // making a a child of b would loop a→b→a
    await expect(assertValidParentImpl(db, a.id, b.id)).rejects.toThrow(/circular/);
  });

  it('tolerates a dangling parent pointer while walking', async () => {
    const p = await mk();
    await db.update(issues).set({ parentId: 999999 }).where(eq(issues.id, p.id));
    const c = await mk();
    await expect(assertValidParentImpl(db, c.id, p.id)).resolves.toBeUndefined();
  });

  it('breaks out of a pre-existing data loop without hanging', async () => {
    const x = await mk();
    const y = await mk();
    await db.update(issues).set({ parentId: y.id }).where(eq(issues.id, x.id));
    await db.update(issues).set({ parentId: x.id }).where(eq(issues.id, y.id)); // x↔y loop
    const z = await mk();
    await expect(assertValidParentImpl(db, z.id, x.id)).resolves.toBeUndefined();
  });
});

describe('rollupParentDoneRatioImpl', () => {
  it('no-ops when the parent has no children', async () => {
    const p = await mk({ doneRatio: 30 });
    await rollupParentDoneRatioImpl(db, p.id);
    const row = await db.query.issues.findFirst({ where: eq(issues.id, p.id) });
    expect(row!.doneRatio).toBe(30); // untouched
  });

  it('averages children done ratios', async () => {
    const p = await mk();
    await mk({ parentId: p.id, doneRatio: 20 });
    await mk({ parentId: p.id, doneRatio: 60 });
    await rollupParentDoneRatioImpl(db, p.id);
    const row = await db.query.issues.findFirst({ where: eq(issues.id, p.id) });
    expect(row!.doneRatio).toBe(40);
  });
});

describe('createIssueImpl parent handling', () => {
  it('creates under a valid parent and rolls up the parent done ratio', async () => {
    const p = await mk();
    const c = await mk({ parentId: p.id, doneRatio: 50 });
    const got = await getIssueImpl(db, p.id);
    expect(got.children.map((k) => k.id)).toEqual([c.id]);
    expect((await db.query.issues.findFirst({ where: eq(issues.id, p.id) }))!.doneRatio).toBe(50);
  });

  it('rejects a cross-project parent at creation', async () => {
    const other = await insertProject(db, { identifier: 'o2', key: 'O2' });
    const foreign = await mk({ projectId: other.id });
    await expect(mk({ parentId: foreign.id })).rejects.toThrow(/same project/);
  });
});

describe('updateIssueImpl re-parenting + roll-up', () => {
  it('attaches a child and rolls up the new parent', async () => {
    const p = await mk();
    const c = await mk({ doneRatio: 80 });
    await updateIssueImpl(db, alice, { id: c.id, notes: '', changes: { parentId: p.id } });
    expect((await db.query.issues.findFirst({ where: eq(issues.id, c.id) }))!.parentId).toBe(p.id);
    expect((await db.query.issues.findFirst({ where: eq(issues.id, p.id) }))!.doneRatio).toBe(80);
  });

  it('moves a child between parents, rolling up both', async () => {
    const a = await mk();
    const b = await mk();
    const c = await mk({ parentId: a.id, doneRatio: 100 }); // create rolls a up to 100
    await updateIssueImpl(db, alice, { id: c.id, notes: '', changes: { parentId: b.id } });
    // a is now childless → roll-up is a no-op, so it keeps its last value (100);
    // b inherits the child's 100.
    expect((await db.query.issues.findFirst({ where: eq(issues.id, a.id) }))!.doneRatio).toBe(100);
    expect((await db.query.issues.findFirst({ where: eq(issues.id, b.id) }))!.doneRatio).toBe(100);
  });

  it('detaches a child (parentId → null)', async () => {
    const p = await mk();
    const c = await mk({ parentId: p.id });
    await updateIssueImpl(db, alice, { id: c.id, notes: '', changes: { parentId: null } });
    expect((await db.query.issues.findFirst({ where: eq(issues.id, c.id) }))!.parentId).toBeNull();
  });

  it('skips validation when parentId is set to its current value', async () => {
    const p = await mk();
    const c = await mk({ parentId: p.id });
    await expect(
      updateIssueImpl(db, alice, { id: c.id, notes: '', changes: { parentId: p.id } }),
    ).resolves.toBeTruthy();
  });

  it('rolls up the parent when a child done ratio changes', async () => {
    const p = await mk();
    const c = await mk({ parentId: p.id, doneRatio: 0 });
    await updateIssueImpl(db, alice, { id: c.id, notes: '', changes: { doneRatio: 60 } });
    expect((await db.query.issues.findFirst({ where: eq(issues.id, p.id) }))!.doneRatio).toBe(60);
  });

  it('does not roll up a parentless issue on done-ratio change', async () => {
    const a = await mk({ doneRatio: 0 });
    await updateIssueImpl(db, alice, { id: a.id, notes: '', changes: { doneRatio: 90 } });
    expect((await db.query.issues.findFirst({ where: eq(issues.id, a.id) }))!.doneRatio).toBe(90);
  });

  it('rejects a re-parent that would create a cycle', async () => {
    const a = await mk();
    const b = await mk({ parentId: a.id });
    await expect(
      updateIssueImpl(db, alice, { id: a.id, notes: '', changes: { parentId: b.id } }),
    ).rejects.toThrow(/circular/);
  });
});
