import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { hmacMiddleware } from '../../workers/api/src/middleware/hmac';
import { issuesRouter } from '../../workers/api/src/handlers/issues';
import { signRequest } from '@allenlabs/pm-core/lib/hmac';
import { makeTestDb, insertProject, insertUser, type TestDB } from '../_setup/db';
import type { AppBindings } from '../../workers/api/src/context';

describe('PM REST API (HMAC)', () => {
  let db: TestDB;
  let secret: string;
  let app: Hono<AppBindings>;

  beforeEach(async () => {
    db = await makeTestDb();
    const admin = await insertUser(db, { login: 'alice', admin: true });
    secret = 'unit-test-secret-32-bytes-long-aaa';
    await db.execute(sql`
      INSERT INTO pm.api_clients (client_id, name, hmac_secret, user_id)
      VALUES ('cli', 'CLI', ${secret}, ${admin.id})
    `);
    await insertProject(db, { identifier: 'redmine', key: 'RED', name: 'Redmine' });

    app = new Hono<AppBindings>();
    app.use('/v1/*', hmacMiddleware(() => db));
    app.route('/v1', issuesRouter);
  });

  async function call(path: string, method = 'GET', body = ''): Promise<Response> {
    const ts = Date.now();
    const sig = await signRequest(secret, body, ts);
    return app.request(path, {
      method,
      headers: {
        'X-Client-Id': 'cli',
        'X-Timestamp': String(ts),
        'X-Signature': sig,
        'Content-Type': 'application/json',
      },
      body: method === 'GET' ? undefined : body,
    });
  }

  it('lists projects', async () => {
    const res = await call('/v1/projects');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { projects: Array<{ key: string }> };
    expect(json.projects.map((p) => p.key)).toContain('RED');
  });

  it('creates, fetches, lists, and updates an issue (RED-1)', async () => {
    const body = JSON.stringify({ subject: 'API bug', description: 'broke' });
    const created = await call('/v1/projects/RED/issues', 'POST', body);
    expect(created.status).toBe(201);
    const c = (await created.json()) as { key: string; number: number };
    expect(c.key).toBe('RED-1');
    expect(c.number).toBe(1);

    const got = await call('/v1/projects/RED/issues/1');
    expect(got.status).toBe(200);
    const g = (await got.json()) as { key: string; subject: string };
    expect(g.key).toBe('RED-1');
    expect(g.subject).toBe('API bug');

    const list = await call('/v1/projects/RED/issues?status=all');
    const l = (await list.json()) as { total: number; issues: Array<{ key: string }> };
    expect(l.total).toBe(1);
    expect(l.issues[0]!.key).toBe('RED-1');

    const upd = await call('/v1/projects/RED/issues/1', 'POST', JSON.stringify({ notes: 'looking' }));
    expect(upd.status).toBe(200);
  });

  it('manages the subtask hierarchy (parent / children endpoints + create parentNumber)', async () => {
    // RED-1 parent, RED-2 child via create parentNumber
    await call('/v1/projects/RED/issues', 'POST', JSON.stringify({ subject: 'parent' }));
    const childRes = await call(
      '/v1/projects/RED/issues',
      'POST',
      JSON.stringify({ subject: 'child', parentNumber: 1, doneRatio: 50 }),
    );
    expect(childRes.status).toBe(201);

    // parent rolled up to the child's done ratio; GET exposes parent/children
    const parent = (await (await call('/v1/projects/RED/issues/1')).json()) as {
      doneRatio: number;
      children: string[];
    };
    expect(parent.children).toEqual(['RED-2']);
    expect(parent.doneRatio).toBe(50);
    const child = (await (await call('/v1/projects/RED/issues/2')).json()) as { parent: string | null };
    expect(child.parent).toBe('RED-1');

    // detach via parent endpoint
    const detach = await call('/v1/projects/RED/issues/2/parent', 'POST', JSON.stringify({ parentNumber: null }));
    expect(detach.status).toBe(200);
    expect(((await (await call('/v1/projects/RED/issues/2')).json()) as { parent: string | null }).parent).toBeNull();

    // re-attach via children endpoint (make RED-1 the parent of RED-2)
    const attach = await call('/v1/projects/RED/issues/1/children', 'POST', JSON.stringify({ childNumber: 2 }));
    expect(attach.status).toBe(200);
    expect((await attach.json())).toEqual({ parent: 'RED-1', child: 'RED-2' });

    // cycle rejected with 422 (make RED-1 a child of RED-2)
    const cycle = await call('/v1/projects/RED/issues/1/parent', 'POST', JSON.stringify({ parentNumber: 2 }));
    expect(cycle.status).toBe(422);
  });

  it('creates an issue related to an existing one', async () => {
    await call('/v1/projects/RED/issues', 'POST', JSON.stringify({ subject: 'base' })); // RED-1
    const res = await call(
      '/v1/projects/RED/issues',
      'POST',
      JSON.stringify({ subject: 'linked', relations: [{ targetNumber: 1, type: 'blocks' }] }),
    );
    expect(res.status).toBe(201);
    const got = (await (await call('/v1/projects/RED/issues/2')).json()) as {
      relations: Array<{ type: string; key: string }>;
    };
    expect(got.relations).toEqual([{ type: 'blocks', key: 'RED-1' }]);
  });

  it('422s when a relation target is missing at creation', async () => {
    const res = await call(
      '/v1/projects/RED/issues',
      'POST',
      JSON.stringify({ subject: 'x', relations: [{ targetNumber: 999, type: 'relates' }] }),
    );
    expect(res.status).toBe(422);
  });

  it('lower-cases the project key on resolve', async () => {
    const got = await call('/v1/projects/red/issues?status=all');
    expect(got.status).toBe(200);
  });

  it('404s for an unknown project or issue', async () => {
    expect((await call('/v1/projects/NOPE/issues')).status).toBe(404);
    expect((await call('/v1/projects/RED/issues/999')).status).toBe(404);
  });

  it('422s on validation failure', async () => {
    const res = await call('/v1/projects/RED/issues', 'POST', JSON.stringify({ subject: '' }));
    expect(res.status).toBe(422);
  });

  it('400s on invalid JSON body', async () => {
    const res = await call('/v1/projects/RED/issues', 'POST', 'not json');
    expect(res.status).toBe(400);
  });

  describe('auth failures', () => {
    it('401s without auth headers', async () => {
      const res = await app.request('/v1/projects');
      expect(res.status).toBe(401);
    });

    it('401s on a bad signature', async () => {
      const ts = Date.now();
      const res = await app.request('/v1/projects', {
        headers: { 'X-Client-Id': 'cli', 'X-Timestamp': String(ts), 'X-Signature': 'AAAA' },
      });
      expect(res.status).toBe(401);
    });

    it('401s for an unknown client', async () => {
      const ts = Date.now();
      const sig = await signRequest(secret, '', ts);
      const res = await app.request('/v1/projects', {
        headers: { 'X-Client-Id': 'ghost', 'X-Timestamp': String(ts), 'X-Signature': sig },
      });
      expect(res.status).toBe(401);
    });

    it('401s on a non-numeric timestamp', async () => {
      const res = await app.request('/v1/projects', {
        headers: { 'X-Client-Id': 'cli', 'X-Timestamp': 'abc', 'X-Signature': 'AAAA' },
      });
      expect(res.status).toBe(401);
    });
  });

  describe('permissions', () => {
    it('403s when the client user cannot view a private project', async () => {
      // A second, non-admin client with no membership on a private project.
      const bob = await insertUser(db, { login: 'bob', email: 'bob@x.test' });
      await insertProject(db, { identifier: 'secret', key: 'SEC', name: 'Secret', isPublic: false });
      await db.execute(sql`
        INSERT INTO pm.api_clients (client_id, name, hmac_secret, user_id)
        VALUES ('bob-cli', 'Bob CLI', ${secret}, ${bob.id})
      `);
      const ts = Date.now();
      const sig = await signRequest(secret, '', ts);
      const res = await app.request('/v1/projects/SEC/issues', {
        headers: { 'X-Client-Id': 'bob-cli', 'X-Timestamp': String(ts), 'X-Signature': sig },
      });
      expect(res.status).toBe(403);
    });
  });
});
