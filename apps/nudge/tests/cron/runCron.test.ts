import { describe, expect, it, beforeEach } from 'vitest';
import { runCron, type CronEnv } from '../../workers/cron/runCron';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import { createReminderImpl, getReminderImpl } from '~/server/nudge';

function makeFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return await handler(req);
  }) as typeof fetch;
}

describe('runCron', () => {
  let db: TestDB;
  let env: CronEnv;
  beforeEach(async () => {
    db = await makeTestDb();
    env = {
      HYPERDRIVE: {} as Hyperdrive,
      INBOX_API_URL: 'https://inbox-api.test',
      INBOX_HMAC_CLIENT_ID: 'nudge-cron',
      INBOX_HMAC_SECRET: 'shared-secret-32-bytes-long-aaaa',
      CRON_MAX_REMINDERS: '500',
      PUBLIC_WEB_URL: 'https://nudge.test/',
    };
  });

  it('delivers a due reminder via inbox push + marks it delivered', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    const r = await createReminderImpl(db, u.id, { text: 'water', relativeSeconds: 1 }, past);
    const calls: Array<{ url: string; body: string }> = [];
    const fetchFn = makeFetch(async (req) => {
      calls.push({ url: req.url, body: await req.text() });
      return new Response('{}', { status: 200 });
    });
    const result = await runCron(env, () => db, now, fetchFn);
    expect(result.scanned).toBe(1);
    expect(result.delivered).toBe(1);
    expect(result.errors).toBe(0);
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe('https://inbox-api.test/v1/notify');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      userId: u.id,
      title: 'Nudge',
      body: 'water',
    });
    const row = await getReminderImpl(db, u.id, r.id);
    expect(row?.deliveredAt).not.toBeNull();
  });

  it('skips delivery when inbox not configured', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 1 }, past);
    const result = await runCron(
      { ...env, INBOX_API_URL: undefined, INBOX_HMAC_CLIENT_ID: undefined, INBOX_HMAC_SECRET: undefined },
      () => db,
      now,
      makeFetch(() => new Response('{}', { status: 200 })),
    );
    expect(result.skipped).toBe(1);
    expect(result.delivered).toBe(0);
  });

  it('records errors on inbox failure', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 1 }, past);
    const result = await runCron(
      env,
      () => db,
      now,
      makeFetch(() => new Response('boom', { status: 500 })),
    );
    expect(result.errors).toBe(1);
    expect(result.delivered).toBe(0);
  });

  it('catches per-reminder throws without crashing the loop', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    await createReminderImpl(db, u.id, { text: 'a', relativeSeconds: 1 }, past);
    await createReminderImpl(db, u.id, { text: 'b', relativeSeconds: 1 }, past);
    let call = 0;
    const fetchFn = makeFetch(() => {
      call++;
      if (call === 1) throw new Error('boom');
      return new Response('{}', { status: 200 });
    });
    const result = await runCron(env, () => db, now, fetchFn);
    expect(result.scanned).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.delivered).toBe(1);
  });

  it('catches non-Error throws', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    await createReminderImpl(db, u.id, { text: 'a', relativeSeconds: 1 }, past);
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    const fetchFn = makeFetch(() => {
      throw 'plain string';
    });
    const result = await runCron(env, () => db, now, fetchFn);
    expect(result.errors).toBe(1);
  });

  it('advances recurring reminders', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const fireAt = new Date(now.getTime() - 60_000);
    const r = await createReminderImpl(
      db,
      u.id,
      { text: 'water', fireAt: fireAt.toISOString(), recurrence: 'daily' },
      fireAt,
    );
    const fetchFn = makeFetch(() => new Response('{}', { status: 200 }));
    await runCron(env, () => db, now, fetchFn);
    const row = await getReminderImpl(db, u.id, r.id);
    expect(row?.deliveredAt).toBeNull();
    expect(row?.fireAt).toBe(new Date(fireAt.getTime() + 86_400_000).toISOString());
  });

  it('honours CRON_MAX_REMINDERS', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    for (let i = 0; i < 3; i++) {
      await createReminderImpl(db, u.id, { text: `r${i}`, relativeSeconds: 1 }, past);
    }
    const fetchFn = makeFetch(() => new Response('{}', { status: 200 }));
    const result = await runCron(
      { ...env, CRON_MAX_REMINDERS: '2' },
      () => db,
      now,
      fetchFn,
    );
    expect(result.scanned).toBe(2);
  });

  it('defaults CRON_MAX_REMINDERS when unset', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 1 }, past);
    const fetchFn = makeFetch(() => new Response('{}', { status: 200 }));
    const result = await runCron(
      { ...env, CRON_MAX_REMINDERS: undefined },
      () => db,
      now,
      fetchFn,
    );
    expect(result.scanned).toBe(1);
  });

  it('uses default PUBLIC_WEB_URL when unset', async () => {
    const u = await insertPmUser(db, { login: 'a' });
    const now = new Date('2026-05-24T10:00:00Z');
    const past = new Date(now.getTime() - 60_000);
    await createReminderImpl(db, u.id, { text: 'x', relativeSeconds: 1 }, past);
    const calls: Array<{ body: string }> = [];
    const fetchFn = makeFetch(async (req) => {
      calls.push({ body: await req.text() });
      return new Response('{}', { status: 200 });
    });
    await runCron({ ...env, PUBLIC_WEB_URL: undefined }, () => db, now, fetchFn);
    expect(JSON.parse(calls[0]!.body).url).toBe('https://nudge.allenlabs.org/');
  });
});
