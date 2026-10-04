import { describe, expect, it, beforeEach } from 'vitest';
import { runCron, type CronEnv } from '../../workers/cron/runCron';
import { insertPmUser, makeTestDb, type TestDB } from '../_setup/db';
import { listNudgesImpl, setPreferencesImpl } from '~/server/concierge';

function makeFetch(handler: (req: Request) => Promise<Response> | Response): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    return await handler(req);
  }) as typeof fetch;
}

function llmReply(content: string): Response {
  return new Response(
    JSON.stringify({
      model: 'gpt-4o-mini',
      choices: [{ message: { content } }],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('runCron', () => {
  let db: TestDB;
  let env: CronEnv;
  beforeEach(async () => {
    db = await makeTestDb();
    env = {
      HYPERDRIVE: {} as Hyperdrive,
      LLM_BASE_URL: 'https://llm.test/v1',
      LLM_API_KEY: 'k',
      LLM_MODEL: 'gpt-4o-mini',
      CRON_MAX_USERS: '100',
    };
  });

  it('iterates enabled users and sends nudges', async () => {
    const a = await insertPmUser(db, { login: 'alice' });
    const b = await insertPmUser(db, { login: 'bob', sub: 'sso-b' });
    await setPreferencesImpl(db, a.id, { enabled: true });
    await setPreferencesImpl(db, b.id, { enabled: true });
    const fetchFn = makeFetch(() => llmReply('Q?'));
    const result = await runCron(env, () => db, new Date(), fetchFn);
    expect(result.scanned).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.errors).toBe(0);
    expect((await listNudgesImpl(db, a.id)).length).toBe(1);
    expect((await listNudgesImpl(db, b.id)).length).toBe(1);
  });

  it('counts skipped users (disabled / cadence)', async () => {
    const a = await insertPmUser(db, { login: 'alice' });
    const b = await insertPmUser(db, { login: 'bob', sub: 'sso-b' });
    await setPreferencesImpl(db, a.id, { enabled: true });
    await setPreferencesImpl(db, b.id, { enabled: true });
    // a will be sent, b will be SKIP-ed by the LLM
    let call = 0;
    const fetchFn = makeFetch(() => {
      call++;
      return llmReply(call === 1 ? 'q' : 'SKIP');
    });
    const result = await runCron(env, () => db, new Date(), fetchFn);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it('captures errors per-user without crashing the loop', async () => {
    const a = await insertPmUser(db, { login: 'alice' });
    const b = await insertPmUser(db, { login: 'bob', sub: 'sso-b' });
    await setPreferencesImpl(db, a.id, { enabled: true });
    await setPreferencesImpl(db, b.id, { enabled: true });
    let call = 0;
    const fetchFn = makeFetch(() => {
      call++;
      if (call === 1) throw new Error('boom');
      return llmReply('q');
    });
    const result = await runCron(env, () => db, new Date(), fetchFn);
    expect(result.errors).toBe(1);
    expect(result.sent).toBe(1);
  });

  it('captures non-Error throwables in the per-user catch', async () => {
    const a = await insertPmUser(db, { login: 'alice' });
    await setPreferencesImpl(db, a.id, { enabled: true });
    // eslint-disable-next-line @typescript-eslint/no-throw-literal
    const fetchFn = makeFetch(() => {
      throw 'plain string';
    });
    const result = await runCron(env, () => db, new Date(), fetchFn);
    expect(result.errors).toBe(1);
  });

  it('honours CRON_MAX_USERS', async () => {
    for (let i = 0; i < 3; i++) {
      const u = await insertPmUser(db, { login: `u${i}`, sub: `sso-${i}` });
      await setPreferencesImpl(db, u.id, { enabled: true });
    }
    const fetchFn = makeFetch(() => llmReply('q'));
    const limited = await runCron(
      { ...env, CRON_MAX_USERS: '2' },
      () => db,
      new Date(),
      fetchFn,
    );
    expect(limited.scanned).toBe(2);
  });

  it('defaults CRON_MAX_USERS when unset', async () => {
    const u = await insertPmUser(db, { login: 'alice' });
    await setPreferencesImpl(db, u.id, { enabled: true });
    const fetchFn = makeFetch(() => llmReply('q'));
    const result = await runCron(
      { ...env, CRON_MAX_USERS: undefined },
      () => db,
      new Date(),
      fetchFn,
    );
    expect(result.scanned).toBe(1);
  });
});
