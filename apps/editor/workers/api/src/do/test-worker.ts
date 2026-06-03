// Minimal Worker entry used ONLY by the @cloudflare/vitest-pool-workers
// integration test in `tests/workers/`. It exists so Miniflare can instantiate
// the `WorkspaceDB` SQLite Durable Object (named by the `durableObjects`
// binding in vitest.config.ts) WITHOUT pulling the full API worker
// (`src/index.ts` → Hono + postgres + otel), which would drag the postgres
// client into the workers bundle and is unrelated to exercising the DO.
//
// The DO is driven directly through its namespace stub in the test
// (`env.WORKSPACE_DB.idFromName(...).get(...)`), so this fetch handler is just
// a placeholder that keeps Miniflare happy.

export { WorkspaceDB } from './workspace-db';

export default {
  async fetch(): Promise<Response> {
    return new Response('ok');
  },
} satisfies ExportedHandler;
