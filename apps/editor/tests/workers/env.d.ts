// Ambient types for the @cloudflare/vitest-pool-workers integration test.
//
// `import { env } from 'cloudflare:test'` is typed as `Cloudflare.Env`; we
// augment that interface so `env.WORKSPACE_DB` is the WorkspaceDB DO namespace
// the miniflare `durableObjects` binding (vitest.config.ts) exposes.

/// <reference types="@cloudflare/vitest-pool-workers/types" />

import type { WorkspaceDB } from '@api/do/workspace-db';

declare global {
  namespace Cloudflare {
    interface Env {
      WORKSPACE_DB: DurableObjectNamespace<WorkspaceDB>;
    }
  }
}

export {};
