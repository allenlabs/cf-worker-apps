import { describe, expect, it } from 'vitest';
import { makeTestEnv } from '../../../src/testing/env';
import { registerAdapter, selectAdapter } from '@allenlabs/pm-core/server/auth/registry';
import { betterAuthAdapter } from '@allenlabs/pm-core/server/auth/adapters/better-auth';
import { oidcAdapter } from '@allenlabs/pm-core/server/auth/adapters/oidc';
import type { AuthAdapter } from '@allenlabs/pm-core/server/auth/types';

describe('selectAdapter', () => {
  it('defaults to the betterAuth adapter', () => {
    expect(selectAdapter(makeTestEnv())).toBe(betterAuthAdapter);
  });

  it('selects the oidc adapter by AUTH_ADAPTER=oidc', () => {
    expect(selectAdapter(makeTestEnv({ AUTH_ADAPTER: 'oidc' }))).toBe(oidcAdapter);
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
