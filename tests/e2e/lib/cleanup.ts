/**
 * Idempotent teardown: DELETE every e2e-tagged row across every schema we
 * touch.  Safe to run standalone (`npm run -w @cf-worker-apps/e2e cleanup`)
 * after a manual session went sideways.
 *
 * Tag conventions (mirrors tests/e2e/lib/fixtures.ts):
 *   - inbox.items.tags         contains 'e2e-test'
 *   - focus.sessions.task_text starts with '[e2e]'
 *   - context.snapshots.name   starts with 'e2e-'
 *   - concierge.nudges.question OR context_summary starts with '[e2e]'
 *   - concierge.preferences    snapshotted+restored by the spec itself
 *                              (cleanup also drops any row whose updated_at
 *                              moved during a test if a snapshot row exists
 *                              tagged in concierge.nudges — see spec for the
 *                              restoration pattern)
 *   - pm.projects.identifier   starts with 'e2e-' (if we ever scaffold one)
 *
 * Order matters because of FK cascade:
 *   focus.distractions → focus.sessions
 *   pm.issues          → pm.projects
 *
 * Credentials: tries process.env.DATABASE_URL first; if missing, attempts
 * pass-cli (fall back is best-effort because pass-cli often needs an
 * interactive login).  Either way we connect to the shared Hetzner PG.
 */

import { spawnSync } from 'node:child_process';
import { Client } from 'pg';

interface DeleteResult {
  table: string;
  rows: number;
}

export interface CleanupOptions {
  /** Override DATABASE_URL (e.g. for tests). */
  databaseUrl?: string;
  /** If true, suppress the per-table console log. */
  quiet?: boolean;
}

function resolveDatabaseUrl(opts: CleanupOptions): string {
  const env = opts.databaseUrl ?? process.env.DATABASE_URL;
  if (env) return env;

  // Last-ditch: try pass-cli.  We deliberately swallow any failure here so
  // CI-style runs that export DATABASE_URL never accidentally fall into an
  // interactive prompt.
  const result = spawnSync(
    'pass-cli',
    [
      'item',
      'view',
      '--vault-name',
      'Development',
      '--item-title',
      'Allenlabs PostgreSQL Hetzner',
      '--output',
      'json',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0 || !result.stdout) {
    throw new Error(
      '[e2e:cleanup] DATABASE_URL not set and pass-cli lookup failed.\n' +
        '  Export DATABASE_URL=postgres://… before running cleanup.\n' +
        `  pass-cli stderr: ${result.stderr?.slice(0, 200) ?? '(none)'}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (err) {
    throw new Error(`[e2e:cleanup] pass-cli output was not JSON: ${String(err)}`);
  }
  // Item shape: { fields: [{ name, value }, ...], ... } — pluck a URL-shaped value.
  const url = extractDatabaseUrl(parsed);
  if (!url) {
    throw new Error(
      '[e2e:cleanup] pass-cli item found but no postgres:// URL inside it.',
    );
  }
  return url;
}

export function extractDatabaseUrl(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const stack: unknown[] = [parsed];
  while (stack.length) {
    const cur = stack.pop();
    if (typeof cur === 'string' && /^postgres(ql)?:\/\//.test(cur)) return cur;
    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else if (cur && typeof cur === 'object') {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return null;
}

/**
 * Run the deletes.  Each query is independent so a missing schema (e.g.
 * `pm` not deployed yet, or `context` skipped) doesn't break the others.
 */
export async function cleanup(opts: CleanupOptions = {}): Promise<DeleteResult[]> {
  const dbUrl = resolveDatabaseUrl(opts);
  // node-postgres v8 has changed its sslmode semantics: when the URL says
  // sslmode=require, it now defaults to verify-full and rejects self-signed
  // certs (Hetzner managed PG ships a self-signed cert).  We strip the
  // sslmode= query param and set `ssl: { rejectUnauthorized: false }`
  // explicitly so pg honours our weaker security stance.
  const sanitizedUrl = dbUrl.replace(/([?&])sslmode=[^&]*&?/g, (_m, sep) => sep === '?' ? '?' : '');
  // Drop a dangling ? or & after the strip.
  const finalUrl = sanitizedUrl.replace(/[?&]$/, '');
  const needsSsl = /sslmode=(require|verify-)/i.test(dbUrl) || dbUrl.includes(':5432');
  const client = new Client({
    connectionString: finalUrl,
    ssl: needsSsl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  const results: DeleteResult[] = [];
  try {
    const queries: Array<{ table: string; sql: string }> = [
      // focus first because of FK from distractions → sessions
      {
        table: 'focus.distractions',
        sql: `
          DELETE FROM focus.distractions d
            USING focus.sessions s
            WHERE d.session_id = s.id AND s.task_text LIKE '[e2e]%'
        `,
      },
      {
        table: 'focus.sessions',
        sql: `DELETE FROM focus.sessions WHERE task_text LIKE '[e2e]%'`,
      },
      {
        table: 'inbox.items',
        sql: `DELETE FROM inbox.items WHERE 'e2e-test' = ANY(tags)`,
      },
      {
        table: 'context.snapshots',
        sql: `DELETE FROM context.snapshots WHERE name LIKE 'e2e-%'`,
      },
      // Concierge nudges — tagged in-band via the `[e2e]` prefix on either
      // the question OR the LLM-context summary (whichever the test seeded).
      {
        table: 'concierge.nudges',
        sql: `DELETE FROM concierge.nudges
              WHERE question LIKE '[e2e]%'
                 OR context_summary LIKE '[e2e]%'`,
      },
      // Concierge preferences are user-scoped (one row per user) and a test
      // may toggle `enabled` on user_id=1 to verify the flow.  The
      // concierge.spec snapshots the row BEFORE the test and restores it
      // AFTER, so this cleanup is a fallback: if the spec crashed before
      // restoring, we delete only those preference rows that were created by
      // a test (i.e. have NO nudges of their own and were freshly inserted
      // — heuristic: cleanup runs whether a snapshot exists or not, and the
      // spec writes its own restoration; we leave preferences alone here to
      // avoid clobbering real user state).  Intentionally no DELETE.
      // PM may not exist on every install; we attempt and swallow "schema
      // does not exist" / "relation does not exist" errors.
      {
        table: 'pm.issues',
        sql: `
          DELETE FROM pm.issues i
            USING pm.projects p
            WHERE i.project_id = p.id AND p.identifier LIKE 'e2e-%'
        `,
      },
      {
        table: 'pm.projects',
        sql: `DELETE FROM pm.projects WHERE identifier LIKE 'e2e-%'`,
      },
      // Editor pages: children / comments / versions cascade via FKs, so a
      // single delete on the root title prefix is sufficient. Schema may not
      // exist on every install; the "does not exist" guard below swallows it.
      //
      // NOTE (Datasource Step 2): a native_do database's rows/properties/views
      // live in the per-workspace WorkspaceDB Durable Object, NOT in
      // editor.pages — so this DELETE removes the lightweight PG container page
      // but NOT the DO data. editor-native-db.spec deletes the database through
      // the app (which calls the dropDatabase DO RPC), so the DO data is cleaned
      // up by the spec itself; this row only mops up the container page if the
      // spec aborted before its in-app delete (a stale DO is harmless + bounded).
      {
        table: 'editor.pages',
        sql: `DELETE FROM editor.pages WHERE title LIKE 'e2e-%'`,
      },
      // Datasource Step 2 safety net: a native_do container whose `e2e-` rename
      // never persisted (the original bug) keeps the default title 'Untitled
      // database', so the title-prefix delete above MISSES it and it leaks.
      // `db_backend='native_do'` is a reliable marker — the feature isn't
      // user-facing, so every native_do row in editor.pages is e2e-created. We
      // still AND `title LIKE 'e2e-%' OR title LIKE 'Untitled%'` so this never
      // touches a (hypothetical) real native database a human made. This drops
      // the leaked PG container; the bounded stale DO is harmless + retryable.
      {
        table: 'editor.pages (native_do)',
        sql: `DELETE FROM editor.pages
              WHERE db_backend = 'native_do'
                AND (title LIKE 'e2e-%' OR title LIKE 'Untitled%')`,
      },
    ];

    for (const { table, sql } of queries) {
      try {
        const r = await client.query(sql);
        results.push({ table, rows: r.rowCount ?? 0 });
        if (!opts.quiet) {
          console.log(`[e2e:cleanup] ${table.padEnd(22)} → ${r.rowCount ?? 0} row(s) deleted`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // "does not exist" is fine — that schema/table just isn't deployed.
        if (/does not exist/i.test(msg)) {
          if (!opts.quiet) {
            console.log(`[e2e:cleanup] ${table.padEnd(22)} → skipped (${msg.split('\n')[0]})`);
          }
          results.push({ table, rows: 0 });
          continue;
        }
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return results;
}

// CLI entry point — `npm run -w @cf-worker-apps/e2e cleanup`.
const isMain = (() => {
  try {
    // tsx / node ESM: process.argv[1] is the script path.
    const argv = process.argv[1] ?? '';
    return argv.endsWith('cleanup.ts') || argv.endsWith('cleanup.js');
  } catch {
    return false;
  }
})();

if (isMain) {
  cleanup()
    .then((results) => {
      const total = results.reduce((a, b) => a + b.rows, 0);
      console.log(`[e2e:cleanup] total rows deleted: ${total}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exit(1);
    });
}
