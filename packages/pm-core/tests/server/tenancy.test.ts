import { beforeEach, describe, expect, it } from 'vitest';
import { type TestDB, insertUser, makeTestDb } from '../../src/testing/db';
import { makeTestEnv } from '../../src/testing/env';
import { defaultTenantResolver, type TenantResolver } from '@allenlabs/pm-core/db/client';
import {
  registerTenantResolver,
  resolveTenantDb,
  selectTenantResolver,
  tenantKeyFor,
} from '@allenlabs/pm-core/server/tenancy';

describe('selectTenantResolver', () => {
  it('defaults to the single-DB resolver', () => {
    expect(selectTenantResolver(makeTestEnv())).toBe(defaultTenantResolver);
  });

  it('selects the binding-map resolver by TENANT_RESOLVER', () => {
    expect(selectTenantResolver(makeTestEnv({ TENANT_RESOLVER: 'binding-map' })).id).toBe(
      'binding-map',
    );
  });

  it('selects a registered custom resolver', () => {
    const stub = { id: 'stub-resolver' } as TenantResolver;
    registerTenantResolver(stub);
    expect(selectTenantResolver(makeTestEnv({ TENANT_RESOLVER: 'stub-resolver' }))).toBe(stub);
  });

  it('throws on an unknown resolver id', () => {
    expect(() => selectTenantResolver(makeTestEnv({ TENANT_RESOLVER: 'nope' }))).toThrow(
      /Unknown TENANT_RESOLVER/,
    );
  });
});

describe('tenantKeyFor (default resolver)', () => {
  it('reads the tenant key off the identity', () => {
    expect(tenantKeyFor(makeTestEnv(), { subject: 'x', email: 'a@b', tenant: 'acme' })).toBe('acme');
  });

  it('falls back to "default" for an identity without a tenant', () => {
    expect(tenantKeyFor(makeTestEnv(), { subject: 'x', email: 'a@b' })).toBe('default');
  });

  it('uses the default tenant for an unauthenticated request', () => {
    expect(tenantKeyFor(makeTestEnv(), null)).toBe('default');
  });
});

describe('resolveTenantDb (physical isolation)', () => {
  let dbA: TestDB;
  let dbB: TestDB;

  beforeEach(async () => {
    dbA = await makeTestDb();
    dbB = await makeTestDb();
    await insertUser(dbA, { login: 'alice-in-a', email: 'a@a.test' });
    await insertUser(dbB, { login: 'bob-in-b', email: 'b@b.test' });
    // A 2-tenant resolver routing by the identity's opaque tenant key.
    registerTenantResolver({
      id: 'test-2tenant',
      resolveTenant: (identity) => ({ tenantKey: identity?.tenant ?? 'default' }),
      resolveDb: (tenantKey) => (tenantKey === 'b' ? dbB : dbA),
    });
  });

  it('routes each tenant key to its own database', async () => {
    const env = makeTestEnv({ TENANT_RESOLVER: 'test-2tenant' });
    const keyA = tenantKeyFor(env, { subject: '1', email: 'a@a', tenant: 'a' });
    const keyB = tenantKeyFor(env, { subject: '2', email: 'b@b', tenant: 'b' });
    expect(keyA).toBe('a');
    expect(keyB).toBe('b');

    const fromA = await resolveTenantDb(env, keyA).query.users.findFirst();
    const fromB = await resolveTenantDb(env, keyB).query.users.findFirst();
    expect(fromA?.login).toBe('alice-in-a');
    expect(fromB?.login).toBe('bob-in-b');
  });

  it('routes an unauthenticated request to the default tenant', async () => {
    const env = makeTestEnv({ TENANT_RESOLVER: 'test-2tenant' });
    const key = tenantKeyFor(env, null); // 'default' → dbA branch
    const row = await resolveTenantDb(env, key).query.users.findFirst();
    expect(row?.login).toBe('alice-in-a');
  });
});
