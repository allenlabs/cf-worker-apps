/**
 * Regression coverage for the `wrapWithColdStartRetry` Proxy in
 * `workers/web/app/db/client.ts`.
 *
 * Hyperdrive's first request after a fresh isolate occasionally races the
 * underlying socket setup and surfaces as a `CONNECTION_DESTROYED` /
 * similar connection-shape error from postgres.js.  The Proxy wraps
 * `sql.unsafe(...)` — drizzle's dispatch path — so that any connection-
 * shape failure on the first attempt is retried exactly once.  Real PG
 * errors (SQLSTATE) are NOT retried.
 *
 * We exercise the Proxy directly with a minimal stand-in for a postgres.js
 * client (only `unsafe()` is implemented — the only method the Proxy
 * intercepts), and assert the retry / non-retry behaviour for each error
 * shape.
 */
import { describe, expect, it, vi } from 'vitest';
import { wrapWithColdStartRetry } from '../../src/db/client';

const COLD_START_ERR = Object.assign(new Error('write CONNECTION_DESTROYED'), {
  code: 'CONNECTION_DESTROYED',
});

interface PendingMock {
  then: (onFulfilled?: unknown, onRejected?: unknown) => Promise<unknown>;
  values: () => PendingMock;
}

function pendingResolved(rows: Array<Record<string, unknown>>): PendingMock {
  return {
    then(onFulfilled, onRejected) {
      return Promise.resolve(rows).then(onFulfilled as never, onRejected as never);
    },
    values() {
      const arrays = rows.map((r) => Object.values(r));
      return {
        then(onFulfilled, onRejected) {
          return Promise.resolve(arrays).then(
            onFulfilled as never,
            onRejected as never,
          );
        },
        values() {
          return this;
        },
      };
    },
  };
}

function pendingRejected(err: unknown): PendingMock {
  return {
    then(_onFulfilled, onRejected) {
      return Promise.reject(err).catch(onRejected as never);
    },
    values() {
      return pendingRejected(err);
    },
  };
}

function makeFakeClient(unsafe: ReturnType<typeof vi.fn>) {
  // The Proxy only intercepts `unsafe`; everything else passes through, so a
  // tiny shape is enough for these tests.
  return { unsafe } as unknown as Parameters<typeof wrapWithColdStartRetry>[0];
}

describe('wrapWithColdStartRetry', () => {
  it('retries once on a CONNECTION_DESTROYED error and then succeeds', async () => {
    const unsafe = vi
      .fn()
      .mockReturnValueOnce(pendingRejected(COLD_START_ERR))
      .mockReturnValueOnce(pendingResolved([{ id: 7, login: 'cold-starter' }]));

    const wrapped = wrapWithColdStartRetry(makeFakeClient(unsafe));
    const rows = await wrapped.unsafe('SELECT id, login FROM users LIMIT 1', []);
    expect(rows).toEqual([{ id: 7, login: 'cold-starter' }]);
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a real PG error (SQLSTATE present)', async () => {
    const pgError = Object.assign(new Error('relation "missing" does not exist'), {
      code: '42P01',
      name: 'PostgresError',
    });
    const unsafe = vi.fn().mockReturnValueOnce(pendingRejected(pgError));

    const wrapped = wrapWithColdStartRetry(makeFakeClient(unsafe));
    await expect(wrapped.unsafe('SELECT 1', [])).rejects.toMatchObject({ code: '42P01' });
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it('gives up after all retries if every attempt fails', async () => {
    const unsafe = vi
      .fn()
      .mockReturnValueOnce(pendingRejected(COLD_START_ERR))
      .mockReturnValueOnce(pendingRejected(COLD_START_ERR))
      .mockReturnValueOnce(pendingRejected(COLD_START_ERR));

    const wrapped = wrapWithColdStartRetry(makeFakeClient(unsafe));
    await expect(wrapped.unsafe('SELECT 1', [])).rejects.toMatchObject({
      code: 'CONNECTION_DESTROYED',
    });
    // Three attempts total: initial + 2 retries (per COLD_START_BACKOFFS_MS).
    expect(unsafe).toHaveBeenCalledTimes(3);
  });

  it('retries on array-mode (.values()) results too', async () => {
    const unsafe = vi
      .fn()
      .mockReturnValueOnce(pendingRejected(COLD_START_ERR))
      .mockReturnValueOnce(pendingResolved([{ id: 1, login: 'arr' }]));

    const wrapped = wrapWithColdStartRetry(makeFakeClient(unsafe));
    const result = await wrapped.unsafe('SELECT id, login FROM users', []).values();
    expect(result).toEqual([[1, 'arr']]);
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('retries a plain Error with no code (Hyperdrive socket reset)', async () => {
    const plainErr = new Error('socket hang up');
    const unsafe = vi
      .fn()
      .mockReturnValueOnce(pendingRejected(plainErr))
      .mockReturnValueOnce(pendingResolved([{ ok: 1 }]));

    const wrapped = wrapWithColdStartRetry(makeFakeClient(unsafe));
    const rows = await wrapped.unsafe('SELECT 1', []);
    expect(rows).toEqual([{ ok: 1 }]);
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('inspects e.cause for nested SQLSTATE codes (drizzle "Failed query" wrapper)', async () => {
    const cause = Object.assign(new Error('inner'), { code: '23505', name: 'PostgresError' });
    const wrapper = Object.assign(new Error('Failed query: …'), { cause });
    const unsafe = vi.fn().mockReturnValueOnce(pendingRejected(wrapper));

    const wrapped = wrapWithColdStartRetry(makeFakeClient(unsafe));
    await expect(wrapped.unsafe('INSERT …', [])).rejects.toMatchObject({
      message: expect.stringContaining('Failed query'),
    });
    expect(unsafe).toHaveBeenCalledTimes(1);
  });

  it('retries on non-Error throw values (null, strings, etc.)', async () => {
    const unsafe = vi
      .fn()
      .mockReturnValueOnce(pendingRejected(null))
      .mockReturnValueOnce(pendingResolved([{ ok: 1 }]));

    const wrapped = wrapWithColdStartRetry(makeFakeClient(unsafe));
    const rows = await wrapped.unsafe('SELECT 1', []);
    expect(rows).toEqual([{ ok: 1 }]);
    expect(unsafe).toHaveBeenCalledTimes(2);
  });

  it('passes through non-unsafe properties untouched', async () => {
    const begin = vi.fn();
    const client = { unsafe: vi.fn(), begin, foo: 42 } as unknown as Parameters<
      typeof wrapWithColdStartRetry
    >[0];
    const wrapped = wrapWithColdStartRetry(client);
    // Non-`unsafe` access should be identity-like.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((wrapped as any).foo).toBe(42);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((wrapped as any).begin).toBe(begin);
  });
});
