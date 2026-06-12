import { beforeEach, describe, expect, it } from 'vitest';
import { type TestDB, insertUser, makeTestDb } from '../../src/testing/db';
import { createApiClientImpl, findApiClientImpl } from '../../src/server/api-clients';

let db: TestDB;
let userId: number;

beforeEach(async () => {
  db = await makeTestDb();
  const u = await insertUser(db, { login: 'alice' });
  userId = u.id;
});

describe('api-clients', () => {
  it('creates and finds a client by client_id', async () => {
    const created = await createApiClientImpl(db, {
      clientId: 'cli',
      name: 'CLI',
      hmacSecret: 'secret-value',
      userId,
    });
    expect(created.clientId).toBe('cli');
    const found = await findApiClientImpl(db, 'cli');
    expect(found).toEqual(created);
  });

  it('returns null for an unknown client_id', async () => {
    expect(await findApiClientImpl(db, 'nope')).toBeNull();
  });
});
