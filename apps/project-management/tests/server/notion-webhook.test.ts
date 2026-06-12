// Tests for the inbound notion-gateway webhook.
//
// The route shell (in `routes/api.notion-webhook.tsx`) is thin and runs
// under TanStack Start's request handler — it's exercised by deploy smoke
// tests, not in-process units.  The pure impls in
// `~/server/notion-webhook.ts` carry the coverage budget here.

import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { sign } from '~/server/notion-gateway-client';
import {
  dispatchWebhookImpl,
  translateFieldsImpl,
  verifyWebhookImpl,
} from '~/server/notion-webhook';
import { activities, issueCategories, issueStatuses, issues, journals, trackers, versions } from '@allenlabs/pm-core/db/schema';
import { createIssueImpl, updateIssueImpl } from '~/server/issues';
import { type CurrentUser } from '~/server/auth';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../_setup/db';
import { makeTestEnv } from '../_setup/env';

let db: TestDB;
let alice: CurrentUser;
let projectId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const u = await insertUser(db, { login: 'alice', email: 'alice@example.com' });
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

// ---------- verifyWebhookImpl ----------

describe('verifyWebhookImpl', () => {
  async function signFor(body: string, ts: number) {
    return sign(makeTestEnv().NOTION_GATEWAY_SECRET, ts, body);
  }

  it('accepts a properly signed payload', async () => {
    const body = '{"hello":"world"}';
    const ts = 1000;
    const sig = await signFor(body, ts);
    const r = await verifyWebhookImpl(
      makeTestEnv(),
      body,
      { clientId: 'gateway', timestamp: String(ts), signature: sig },
      ts,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.timestamp).toBe(ts);
  });

  it('rejects the wrong client id', async () => {
    const r = await verifyWebhookImpl(
      makeTestEnv(),
      '{}',
      { clientId: 'someone-else', timestamp: '1', signature: 'x' },
      1,
    );
    expect(r).toEqual({ ok: false, status: 401, message: 'bad client id' });
  });

  it('rejects missing client id', async () => {
    const r = await verifyWebhookImpl(
      makeTestEnv(),
      '{}',
      { clientId: null, timestamp: '1', signature: 'x' },
      1,
    );
    expect(r.ok).toBe(false);
  });

  it('rejects a non-numeric timestamp', async () => {
    const r = await verifyWebhookImpl(
      makeTestEnv(),
      '{}',
      { clientId: 'gateway', timestamp: 'not-a-number', signature: 'x' },
      0,
    );
    expect(r).toEqual({ ok: false, status: 401, message: 'missing timestamp' });
  });

  it('rejects a stale timestamp (>5 min skew)', async () => {
    const body = '{}';
    const oldTs = 1000;
    const sig = await signFor(body, oldTs);
    const now = oldTs + 6 * 60 * 1000;
    const r = await verifyWebhookImpl(
      makeTestEnv(),
      body,
      { clientId: 'gateway', timestamp: String(oldTs), signature: sig },
      now,
    );
    expect(r).toEqual({ ok: false, status: 401, message: 'stale timestamp' });
  });

  it('rejects when the signature header is absent', async () => {
    const r = await verifyWebhookImpl(
      makeTestEnv(),
      '{}',
      { clientId: 'gateway', timestamp: '1', signature: null },
      1,
    );
    expect(r).toEqual({ ok: false, status: 401, message: 'missing signature' });
  });

  it('rejects a wrong signature', async () => {
    const r = await verifyWebhookImpl(
      makeTestEnv(),
      '{"hello":"world"}',
      {
        clientId: 'gateway',
        timestamp: '1000',
        // Plausible-shape base64 that doesn't match the real HMAC.
        signature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      },
      1000,
    );
    expect(r).toEqual({ ok: false, status: 401, message: 'bad signature' });
  });
});

// ---------- translateFieldsImpl ----------

describe('translateFieldsImpl', () => {
  it('maps known status/tracker/priority names into ids (case-insensitive)', async () => {
    const sts = await db.select().from(issueStatuses);
    const newStatus = sts[0]!;
    const trks = await db.select().from(trackers);
    const tr = trks[0]!;
    const changes = await translateFieldsImpl(db, {
      status: newStatus.name.toUpperCase(),
      tracker: tr.name.toLowerCase(),
    });
    expect(changes.statusId).toBe(newStatus.id);
    expect(changes.trackerId).toBe(tr.id);
  });

  it('falls back to null when the name does not match anything', async () => {
    const changes = await translateFieldsImpl(db, {
      status: 'no-such-status',
      tracker: 'no-such-tracker',
      priority: '',
    });
    expect(changes.statusId).toBeNull();
    expect(changes.trackerId).toBeNull();
    expect(changes.priorityId).toBeNull();
  });

  it('resolves assignee email -> user id, and tolerates arrays', async () => {
    const bob = await insertUser(db, { login: 'bob', email: 'bob@x.y' });
    const a = await translateFieldsImpl(db, { assignedTo: 'bob@x.y' });
    expect(a.assignedToId).toBe(bob.id);
    const b = await translateFieldsImpl(db, { assignedTo: ['bob@x.y'] });
    expect(b.assignedToId).toBe(bob.id);
    const c = await translateFieldsImpl(db, { assignedTo: 'unknown@x.y' });
    expect(c.assignedToId).toBeNull();
    const d = await translateFieldsImpl(db, { assignedTo: null });
    expect(d.assignedToId).toBeNull();
    const e = await translateFieldsImpl(db, { assignedTo: [] });
    expect(e.assignedToId).toBeNull();
    // Array path with an email that doesn't match any user.
    const f = await translateFieldsImpl(db, { assignedTo: ['no-such@x.y'] });
    expect(f.assignedToId).toBeNull();
  });

  it('passes through scalar fields verbatim', async () => {
    const changes = await translateFieldsImpl(db, {
      subject: 'new title',
      description: 'new body',
      dueDate: '2026-06-01',
      startDate: '2026-05-30',
      estimatedHours: 3.5,
      doneRatio: 50,
    });
    expect(changes.subject).toBe('new title');
    expect(changes.description).toBe('new body');
    expect(changes.dueDate).toBe('2026-06-01');
    expect(changes.startDate).toBe('2026-05-30');
    expect(changes.estimatedHours).toBe(3.5);
    expect(changes.doneRatio).toBe(50);
  });

  it('coerces non-string scalars to null where strict types are required', async () => {
    const changes = await translateFieldsImpl(db, {
      subject: 123,
      description: 456,
      dueDate: null,
      startDate: null,
      estimatedHours: null,
      doneRatio: 'not-a-number',
    });
    expect(changes.subject).toBeUndefined();
    expect(changes.description).toBeUndefined();
    expect(changes.dueDate).toBeNull();
    expect(changes.startDate).toBeNull();
    expect(changes.estimatedHours).toBeNull();
    expect(changes.doneRatio).toBeUndefined();
  });

  it('resolves category and fixedVersion by name', async () => {
    const [cat] = await db
      .insert(issueCategories)
      .values({ projectId, name: 'Backend' })
      .returning();
    const [ver] = await db
      .insert(versions)
      .values({ projectId, name: 'v1.0' })
      .returning();
    const changes = await translateFieldsImpl(db, {
      category: 'BACKEND',
      fixedVersion: 'v1.0',
    });
    expect(changes.categoryId).toBe(cat!.id);
    expect(changes.fixedVersionId).toBe(ver!.id);
  });
});

// ---------- dispatchWebhookImpl ----------

describe('dispatchWebhookImpl', () => {
  it('ignores an unknown app_record format', async () => {
    const r = await dispatchWebhookImpl(
      db,
      { event: 'page.updated', app_resource: 'project/1', app_record: 'garbage' },
      { systemUser: alice },
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain('unknown record');
  });

  it('ignores an empty/missing app_record (?? "" branch)', async () => {
    const r = await dispatchWebhookImpl(
      db,
      // Cast through unknown — the gateway should never send this, but
      // the guard exists so a malformed event doesn't bubble into 500.
      { event: 'page.updated', app_resource: 'project/1', app_record: undefined as unknown as string },
      { systemUser: alice },
    );
    expect(r.body).toContain('unknown record');
  });

  it('treats a page.updated with no `fields` key as "no changes"', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      doneRatio: 0,
    });
    const r = await dispatchWebhookImpl(
      db,
      {
        event: 'page.updated',
        app_resource: `project/${projectId}`,
        app_record: `issue/${issue.id}`,
        // `fields` deliberately omitted to exercise the `?? {}` branch.
      },
      { systemUser: alice },
    );
    expect(r.body).toContain('no changes');
  });

  it('ignores a missing issue', async () => {
    const r = await dispatchWebhookImpl(
      db,
      { event: 'page.updated', app_resource: 'project/1', app_record: 'issue/9999' },
      { systemUser: alice },
    );
    expect(r.body).toContain('missing issue');
  });

  it('acknowledges an unknown event without doing anything', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'orig',
      description: '',
      doneRatio: 0,
    });
    const r = await dispatchWebhookImpl(
      db,
      {
        event: 'page.unhandled',
        app_resource: `project/${projectId}`,
        app_record: `issue/${issue.id}`,
        fields: { subject: 'should-not-apply' },
      },
      { systemUser: alice },
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain('unknown event');
    const after = await db.query.issues.findFirst({ where: eq(issues.id, issue.id) });
    expect(after?.subject).toBe('orig');
  });

  it('treats page.deleted as a no-op log for v1', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      doneRatio: 0,
    });
    const r = await dispatchWebhookImpl(
      db,
      {
        event: 'page.deleted',
        app_resource: `project/${projectId}`,
        app_record: `issue/${issue.id}`,
      },
      { systemUser: alice },
    );
    expect(r.body).toContain('page.deleted');
  });

  it('updates the issue + records notionOrigin on a page.updated event', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'orig',
      description: '',
      doneRatio: 0,
    });
    const r = await dispatchWebhookImpl(
      db,
      {
        event: 'page.updated',
        app_resource: `project/${projectId}`,
        app_record: `issue/${issue.id}`,
        fields: { subject: 'updated from notion', doneRatio: 75 },
      },
      { systemUser: alice },
    );
    expect(r.status).toBe(200);
    expect(r.body).toContain('updated');
    const after = await db.query.issues.findFirst({ where: eq(issues.id, issue.id) });
    expect(after?.subject).toBe('updated from notion');
    expect(after?.doneRatio).toBe(75);
    // The activity row must carry the notionOrigin marker so future
    // tooling can distinguish gateway-sourced edits from PM-side edits.
    const acts = await db.query.activities.findMany();
    const updated = acts.find((a) => a.kind === 'issue_updated');
    expect(updated?.body).toBe('notionOrigin=true');
  });

  it('returns a "no changes" skip when fields contain nothing recognizable', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      doneRatio: 0,
    });
    const r = await dispatchWebhookImpl(
      db,
      {
        event: 'page.updated',
        app_resource: `project/${projectId}`,
        app_record: `issue/${issue.id}`,
        fields: { totally_unknown: 'noop' },
      },
      { systemUser: alice },
    );
    expect(r.body).toContain('no changes');
  });
});

// ---------- updateIssueImpl notionOrigin flag (unit) ----------

describe('updateIssueImpl notionOrigin flag', () => {
  it('records an empty body on the activity by default', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'orig',
      description: '',
      doneRatio: 0,
    });
    await updateIssueImpl(db, alice, {
      id: issue.id,
      notes: '',
      changes: { subject: 'pm-side' },
    });
    const act = await db.query.activities.findFirst({
      where: eq(activities.kind, 'issue_updated'),
    });
    expect(act?.body).toBe('');
  });

  it('writes notionOrigin=true into the activity body when the flag is set', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'orig',
      description: '',
      doneRatio: 0,
    });
    await updateIssueImpl(
      db,
      alice,
      { id: issue.id, notes: '', changes: { subject: 'webhook-side' } },
      { notionOrigin: true },
    );
    const act = await db.query.activities.findFirst({
      where: eq(activities.kind, 'issue_updated'),
    });
    expect(act?.body).toBe('notionOrigin=true');
    // The journal row itself is unchanged shape-wise.
    const j = await db.query.journals.findFirst({ where: eq(journals.issueId, issue.id) });
    expect(j).toBeDefined();
  });
});
