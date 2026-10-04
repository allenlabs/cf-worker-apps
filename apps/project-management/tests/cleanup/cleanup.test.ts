// Lightweight unit test for the cleanup logic via a hand-rolled fake D1.
// (Full integration coverage lives in tests/workers/ — this is a focused
// sanity check that the SQL filters orphaned attachments correctly.)
import { describe, expect, it } from 'vitest';
import { runCleanup } from '../../workers/cleanup/runCleanup';

function makeFakeEnv(now: Date) {
  const attachments = [
    { id: 1, r2_key: 'a', container_type: 'issue', container_id: 1, created_at: Math.floor(now.getTime() / 1000) - 500 * 86400, filesize: 100 },
    { id: 2, r2_key: 'b', container_type: 'issue', container_id: 2, created_at: Math.floor(now.getTime() / 1000) - 30 * 86400, filesize: 200 },
    { id: 3, r2_key: 'c', container_type: 'wiki_page', container_id: 999, created_at: Math.floor(now.getTime() / 1000) - 400 * 86400, filesize: 300 },
  ];
  const liveContainers = {
    issue: new Set([2]),
    wiki_page: new Set<number>(),
    project: new Set<number>(),
    journal: new Set<number>(),
  };
  const r2Deleted: string[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async <T>() => {
            if (sql.includes('SELECT a.id')) {
              const [cutoff, _limit] = args as [number, number];
              const results = attachments.filter((a) => {
                if (a.created_at >= cutoff) return false;
                const set = liveContainers[a.container_type as keyof typeof liveContainers];
                return !set.has(a.container_id);
              });
              return { results: results as unknown as T[] };
            }
            return { results: [] as T[] };
          },
          run: async () => {
            if (sql.startsWith('DELETE FROM attachments')) {
              const [id] = args as [number];
              const idx = attachments.findIndex((a) => a.id === id);
              if (idx >= 0) attachments.splice(idx, 1);
            }
            return { success: true };
          },
        }),
      }),
    } as unknown as D1Database,
    FILES: {
      delete: async (key: string) => {
        r2Deleted.push(key);
      },
    } as unknown as R2Bucket,
    ATTACHMENT_TTL_DAYS: '365',
    CLEANUP_MAX_ROWS: '100',
    OTEL_ACCESS_ID: 'test-otel-id',
    OTEL_ACCESS_SECRET: 'test-otel-secret',
  };
  return { env, r2Deleted, remainingAttachments: () => attachments };
}

describe('runCleanup', () => {
  it('removes attachments older than TTL with no live container', async () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const { env, r2Deleted, remainingAttachments } = makeFakeEnv(now);

    const result = await runCleanup(env, now);

    expect(result.deleted).toBe(2);
    expect(result.freedBytes).toBe(400); // a=100 + c=300
    expect(r2Deleted.sort()).toEqual(['a', 'c']);
    expect(remainingAttachments().map((a) => a.id)).toEqual([2]);
  });

  it('keeps recent attachments even if their container is gone', async () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const { env, remainingAttachments } = makeFakeEnv(now);
    // Pretend attachment #2 is recent (within TTL) and has lost its container.
    const a = remainingAttachments().find((x) => x.id === 2)!;
    a.created_at = Math.floor(now.getTime() / 1000) - 1 * 86400;
    (env.DB as any).__live = { issue: new Set<number>(), wiki_page: new Set(), project: new Set(), journal: new Set() };

    const result = await runCleanup(env, now);
    // Still only the OLD ones are deleted, not #2 (it's recent).
    expect(result.deleted).toBe(2);
  });
});
