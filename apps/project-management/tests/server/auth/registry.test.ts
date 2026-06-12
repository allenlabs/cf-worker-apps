import { describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../_setup/env';
import { registerAdapter, selectAdapter } from '~/server/auth/registry';
import { betterAuthAdapter } from '~/server/auth/adapters/better-auth';
import type { AuthAdapter } from '~/server/auth/types';

describe('selectAdapter', () => {
  it('defaults to the betterAuth adapter', () => {
    expect(selectAdapter(makeTestEnv())).toBe(betterAuthAdapter);
  });

  it('selects a registered adapter by AUTH_ADAPTER', () => {
    const stub = { id: 'stub' } as AuthAdapter;
    registerAdapter(stub);
    expect(selectAdapter(makeTestEnv({ AUTH_ADAPTER: 'stub' }))).toBe(stub);
  });

  it('throws on an unknown adapter id', () => {
    expect(() => selectAdapter(makeTestEnv({ AUTH_ADAPTER: 'nope' }))).toThrow(/Unknown AUTH_ADAPTER/);
  });
});
