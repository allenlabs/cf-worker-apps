// Tests for the HMAC-signed notion-gateway client.
import { host } from '~/host';
//
// The client only does two distinct things:
//
//   (a) sign + POST a JSON body to the gateway with the right headers
//   (b) translate a PM issue row into the gateway's `fields` map
//
// Each test below exercises one branch with a fetch mock so we never
// touch the network.  The HMAC verification asserts the exact wire
// signature the gateway will check on its side.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type TestDB,
  insertProject,
  insertUser,
  makeTestDb,
} from '../_setup/db';
import { makeTestEnv } from '../_setup/env';
import { issueCategories, versions } from '@allenlabs/pm-core/db/schema';
import { type CurrentUser } from '@allenlabs/pm-core/server/auth';
import { createIssueImpl } from '@allenlabs/pm-core/server/issues';
import {
  deletePage,
  disconnectConnection,
  getConnection,
  getOAuthStartUrl,
  inspectDatabase,
  listDatabases,
  listWorkspaces,
  loadIssueFields,
  pushIssueBackground,
  pushPage,
  sign,
  signedPost,
  upsertConnection,
} from '~/server/notion-gateway-client';

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

function captureFetcher(
  responseFactory: (input: RequestInfo | URL, init?: RequestInit) => Response,
): {
  fetcher: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return Promise.resolve(responseFactory(input, init));
  }) as typeof fetch;
  return { fetcher, calls };
}

// ---------- sign() ----------

describe('sign', () => {
  it('produces a stable base64 HMAC over `${ts}\\n${body}`', async () => {
    const sig1 = await sign('secret', 123, '{"a":1}');
    const sig2 = await sign('secret', 123, '{"a":1}');
    expect(sig1).toBe(sig2);
    // base64 length for SHA-256 (32 bytes) is 44 chars including padding.
    expect(sig1.length).toBe(44);
  });

  it('differs across distinct timestamps + bodies', async () => {
    const a = await sign('secret', 1, '{}');
    const b = await sign('secret', 2, '{}');
    const c = await sign('secret', 1, '{"x":1}');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });
});

// ---------- signedPost — header + signature assertions ----------

describe('signedPost', () => {
  it('issues a POST with X-Client-Id, X-Timestamp, X-Signature', async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = captureFetcher(() =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await signedPost(env, '/v1/test', { hello: 'world' }, { fetcher, now: () => 1000 });
    const call = calls[0]!;
    expect(call.url).toBe('https://notion-api.test/v1/test');
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['X-Client-Id']).toBe('pm');
    expect(headers['X-Timestamp']).toBe('1000');
    expect(typeof headers['X-Signature']).toBe('string');
    // Verify the signature matches an independently-computed one against
    // the exact body the helper serialized.
    const expected = await sign(env.NOTION_GATEWAY_SECRET, 1000, '{"hello":"world"}');
    expect(headers['X-Signature']).toBe(expected);
    expect(call.init.body).toBe('{"hello":"world"}');
  });

  it('strips a trailing slash on the gateway URL so the path is single-slash', async () => {
    const env = makeTestEnv({ NOTION_GATEWAY_URL: 'https://notion-api.test/' });
    const { fetcher, calls } = captureFetcher(() =>
      new Response('{}', { status: 200 }),
    );
    await signedPost(env, '/v1/x', {}, { fetcher });
    expect(calls[0]!.url).toBe('https://notion-api.test/v1/x');
  });

  it('uses the wall clock when `now` is omitted', async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = captureFetcher(() =>
      new Response('{}', { status: 200 }),
    );
    const before = Date.now();
    await signedPost(env, '/v1/x', {}, { fetcher });
    const after = Date.now();
    const ts = Number((calls[0]!.init.headers as Record<string, string>)['X-Timestamp']);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('falls back to the global fetch when no fetcher override is given', async () => {
    const env = makeTestEnv();
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: 1 }), { status: 200 }),
    );
    const out = await signedPost<{ ok: number }>(env, '/v1/x', { a: 1 });
    expect(out.ok).toBe(1);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('throws when the gateway returns a non-2xx', async () => {
    const env = makeTestEnv();
    const { fetcher } = captureFetcher(() =>
      new Response('boom', { status: 500 }),
    );
    await expect(
      signedPost(env, '/v1/test', {}, { fetcher }),
    ).rejects.toThrow(/notion-gateway \/v1\/test 500/);
  });

  it('defaults the body to {} when undefined is passed in', async () => {
    const env = makeTestEnv();
    const { fetcher, calls } = captureFetcher(() =>
      new Response('{}', { status: 200 }),
    );
    await signedPost(env, '/v1/x', undefined, { fetcher });
    expect(calls[0]!.init.body).toBe('{}');
  });
});

// ---------- per-helper smoke tests (each verifies path + body shape) ----------

describe('typed helpers', () => {
  it.each([
    [
      'getOAuthStartUrl',
      '/v1/oauth-start-token',
      { start_url: 'https://x/oauth/start?token=y' },
      () =>
        getOAuthStartUrl(makeTestEnv(), {
          app_resource: 'project/1',
          return_to: 'https://pm/integrations',
        }),
      { app_resource: 'project/1', return_to: 'https://pm/integrations' },
    ],
    [
      'getConnection',
      '/v1/connections/get',
      { connection: null },
      () => getConnection(makeTestEnv(), { app_resource: 'project/2' }),
      { app_resource: 'project/2' },
    ],
    [
      'listWorkspaces',
      '/v1/workspaces/list',
      { workspaces: [] },
      () => listWorkspaces(makeTestEnv()),
      {},
    ],
    [
      'listDatabases',
      '/v1/databases/list',
      { databases: [{ id: 'd', title: 'D' }] },
      () => listDatabases(makeTestEnv(), { workspace_id: 5 }),
      { workspace_id: 5 },
    ],
    [
      'inspectDatabase',
      '/v1/databases/inspect',
      {
        database: { title: 'D', properties: {} },
        suggested: { fields: {} },
        suggested_mapping: { fields: {} },
      },
      () =>
        inspectDatabase(makeTestEnv(), { workspace_id: 5, database_id: 'db1' }),
      { workspace_id: 5, database_id: 'db1' },
    ],
    [
      'upsertConnection',
      '/v1/connections/upsert',
      { connection: { id: 1 } },
      () =>
        upsertConnection(makeTestEnv(), {
          app_resource: 'project/1',
          workspace_id: 5,
          database_id: 'db1',
          database_title: 'D',
          mapping: { fields: {} },
        }),
      {
        app_resource: 'project/1',
        workspace_id: 5,
        database_id: 'db1',
        database_title: 'D',
        mapping: { fields: {} },
      },
    ],
    [
      'disconnectConnection',
      '/v1/connections/delete',
      { ok: true },
      () => disconnectConnection(makeTestEnv(), { app_resource: 'project/1' }),
      { app_resource: 'project/1' },
    ],
    [
      'pushPage',
      '/v1/pages/upsert',
      { page_id: 'p', created: true },
      () =>
        pushPage(makeTestEnv(), {
          app_resource: 'project/1',
          app_record: 'issue/1',
          fields: { subject: 'hi' },
        }),
      { app_resource: 'project/1', app_record: 'issue/1', fields: { subject: 'hi' } },
    ],
    [
      'deletePage',
      '/v1/pages/delete',
      { ok: true, archived: true },
      () =>
        deletePage(makeTestEnv(), { app_resource: 'project/1', app_record: 'issue/1' }),
      { app_resource: 'project/1', app_record: 'issue/1' },
    ],
  ])('%s posts to %s with the expected body', async (_name, path, response, callIt, expectedBody) => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(response), { status: 200 }));
    const out = await callIt();
    expect(out).toEqual(response);
    const call = spy.mock.calls[0]!;
    expect(String(call[0])).toContain(path);
    expect((call[1] as RequestInit).body).toBe(JSON.stringify(expectedBody));
    spy.mockRestore();
  });
});

// ---------- loadIssueFields ----------

describe('loadIssueFields', () => {
  it('returns null for a missing issue', async () => {
    expect(await loadIssueFields(db, 9999)).toBeNull();
  });

  it('hydrates all label/email fields when set', async () => {
    const [cat] = await db
      .insert(issueCategories)
      .values({ projectId, name: 'UI' })
      .returning();
    const [ver] = await db.insert(versions).values({ projectId, name: 'v1' }).returning();
    const assignee = await insertUser(db, { login: 'bob', email: 'bob@x.y' });
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'A bug',
      description: 'desc',
      doneRatio: 10,
      assignedToId: assignee.id,
      categoryId: cat!.id,
      fixedVersionId: ver!.id,
      dueDate: '2026-05-30',
      startDate: '2026-05-23',
      estimatedHours: 2.5,
    }, host);
    const f = await loadIssueFields(db, issue.id);
    expect(f).toMatchObject({
      subject: 'A bug',
      description: 'desc',
      assignedTo: 'bob@x.y',
      category: 'UI',
      fixedVersion: 'v1',
      dueDate: '2026-05-30',
      startDate: '2026-05-23',
      estimatedHours: 2.5,
      doneRatio: 10,
      pmId: `PM-${issue.id}`,
      projectId,
    });
    expect(typeof f?.createdAt).toBe('string');
    expect(f?.status).toBeTruthy();
    expect(f?.tracker).toBeTruthy();
    expect(f?.priority).toBeTruthy();
  });

  it('returns null fk-derived fields when nothing is set', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'naked',
      description: '',
      doneRatio: 0,
    }, host);
    const f = await loadIssueFields(db, issue.id);
    expect(f?.assignedTo).toBeNull();
    expect(f?.category).toBeNull();
    expect(f?.fixedVersion).toBeNull();
    expect(f?.dueDate).toBeNull();
    expect(f?.startDate).toBeNull();
    expect(f?.estimatedHours).toBeNull();
  });
});

// ---------- pushIssueBackground ----------

describe('pushIssueBackground', () => {
  it('POSTs to /v1/pages/upsert when the issue exists', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      doneRatio: 0,
    }, host);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return Promise.resolve(
        new Response(JSON.stringify({ page_id: 'p', created: true }), { status: 200 }),
      );
    }) as typeof fetch;
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    pushIssueBackground(makeTestEnv(), ctx, db, issue.id, { fetcher });
    await Promise.all(waits);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/v1/pages/upsert');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.app_resource).toBe(`project/${projectId}`);
    expect(body.app_record).toBe(`issue/${issue.id}`);
    expect(body.fields.subject).toBe('x');
    // `projectId` is stripped from the outbound fields so it can't be
    // accidentally written into a Notion property.
    expect(body.fields.projectId).toBeUndefined();
  });

  it('silently no-ops when the issue has been deleted', async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ page_id: 'p', created: true }), { status: 200 }),
    );
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    pushIssueBackground(makeTestEnv(), ctx, db, 99999, { fetcher: fetcher as unknown as typeof fetch });
    await Promise.all(waits);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('swallows a 404 from the gateway (treated as "no connection yet")', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      doneRatio: 0,
    }, host);
    const fetcher = vi.fn(async () => new Response('nope', { status: 404 }));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    pushIssueBackground(makeTestEnv(), ctx, db, issue.id, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    await Promise.all(waits);
    // 404 path is silent — no error is logged.
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('logs other failures but does not throw', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      doneRatio: 0,
    }, host);
    const fetcher = vi.fn(async () => new Response('boom', { status: 500 }));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    pushIssueBackground(makeTestEnv(), ctx, db, issue.id, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    await Promise.all(waits);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('logs non-Error rejections too', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      doneRatio: 0,
    }, host);
    const fetcher = vi.fn(() => Promise.reject('not-an-error'));
    const waits: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p) } as unknown as ExecutionContext;
    pushIssueBackground(makeTestEnv(), ctx, db, issue.id, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    await Promise.all(waits);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it('runs without a ctx — useful for non-fetch entrypoints', async () => {
    const issue = await createIssueImpl(db, alice, {
      projectId,
      trackerId: 1,
      subject: 'x',
      description: '',
      doneRatio: 0,
    }, host);
    let resolveCall!: () => void;
    const called = new Promise<void>((r) => {
      resolveCall = r;
    });
    const fetcher = vi.fn(async () => {
      resolveCall();
      return new Response(JSON.stringify({ page_id: 'p', created: true }), { status: 200 });
    });
    pushIssueBackground(makeTestEnv(), undefined, db, issue.id, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    // Wait until the floating promise has actually hit the fetcher.
    await called;
    expect(fetcher).toHaveBeenCalled();
  });
});
