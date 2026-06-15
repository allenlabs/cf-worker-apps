// Adapter selection. Pure function of env so it stays unit-testable and free of
// SSR runtime. The default is the Better Auth adapter; a deployment can register
// and select another via the AUTH_ADAPTER env var with zero core edits.

import type { Env } from '@allenlabs/pm-core/lib/env';
import type { AuthAdapter } from './types';
import { betterAuthAdapter } from './adapters/better-auth';
import { oidcAdapter } from './adapters/oidc';

const ADAPTERS: Record<string, AuthAdapter> = {
  [betterAuthAdapter.id]: betterAuthAdapter,
  [oidcAdapter.id]: oidcAdapter,
};

/** Register an additional adapter (called from a deployment's worker entry). */
export function registerAdapter(adapter: AuthAdapter): void {
  ADAPTERS[adapter.id] = adapter;
}

export function selectAdapter(env: Env): AuthAdapter {
  const id = env.AUTH_ADAPTER ?? betterAuthAdapter.id;
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`Unknown AUTH_ADAPTER "${id}".`);
  return adapter;
}
