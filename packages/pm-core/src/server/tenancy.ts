// Tenancy resolver selection — the registration/selection layer for the
// physical (per-DB) multi-tenancy seam. Mirrors server/auth/registry.ts: a
// deployment registers a TenantResolver and selects it via TENANT_RESOLVER,
// with zero core edits. The default is the single-DB resolver (env.HYPERDRIVE),
// so a deployment that configures nothing is unchanged.
//
// The TenantResolver interface + the concrete resolvers (default, binding-map)
// live in db/client.ts (the connection layer, where the real DB is built).

import type { Env } from '@allenlabs/pm-core/lib/env';
import type { AuthIdentity } from './auth/types';
import {
  type DB,
  type TenantResolver,
  createBindingMapTenantResolver,
  defaultTenantResolver,
} from '@allenlabs/pm-core/db/client';

export type { TenantResolver };

const RESOLVERS: Record<string, TenantResolver> = {
  [defaultTenantResolver.id]: defaultTenantResolver,
  'binding-map': createBindingMapTenantResolver(),
};

/** Register an additional resolver (called from a deployment's worker entry). */
export function registerTenantResolver(resolver: TenantResolver): void {
  RESOLVERS[resolver.id] = resolver;
}

export function selectTenantResolver(env: Env): TenantResolver {
  const id = env.TENANT_RESOLVER ?? defaultTenantResolver.id;
  const resolver = RESOLVERS[id];
  if (!resolver) throw new Error(`Unknown TENANT_RESOLVER "${id}".`);
  return resolver;
}

/** Opaque tenant key for an identity under the selected resolver. */
export function tenantKeyFor(env: Env, identity: AuthIdentity | null): string {
  return selectTenantResolver(env).resolveTenant(identity, env).tenantKey;
}

/** The DB for a tenant key under the selected resolver (per-request cached). */
export function resolveTenantDb(env: Env, tenantKey: string): DB {
  return selectTenantResolver(env).resolveDb(tenantKey, env);
}
