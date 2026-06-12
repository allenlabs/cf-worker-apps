// HMAC-signed client for the notion-gateway HTTP API.
//
// PM no longer talks to Notion directly — everything (database listing,
// inspect, connect, push, archive, OAuth-start URLs) goes through the
// central gateway at `env.NOTION_GATEWAY_URL`.  Each request is signed
// with base64 HMAC-SHA256 over `${timestamp}\n${body}` using
// `env.NOTION_GATEWAY_SECRET`; the gateway validates a 5-minute clock
// skew on its side.
//
// This module lives under `app/server/` so it's tree-shaken out of the
// client bundle — the HMAC secret must never reach the browser.  We
// follow the same convention as the rest of `server/*`: no `.server.`
// suffix needed because `~/server/*` is already SSR-only by directory
// rule.

import { and, eq } from 'drizzle-orm';
import {
  issueCategories,
  issues,
  users,
  versions,
} from '@allenlabs/pm-core/db/schema';
import { getRefData } from './ref-data';
import type { DB } from '@allenlabs/pm-core/db/client';
import type { Env } from '~/lib/env';
import type {
  DatabaseInspectResponse,
  GatewayConnection,
  ListDatabasesResponse,
  ListWorkspacesResponse,
  NotionMapping,
  OAuthStartTokenResponse,
  PageDeleteResponse,
  PageUpsertResponse,
} from '@cf-worker-apps/notion-gateway/shared/src/types';

// Re-export the few types route components need so they don't have to
// resolve the workspace-path import themselves.
export type {
  DatabaseInspectResponse,
  GatewayConnection,
  NotionMapping,
} from '@cf-worker-apps/notion-gateway/shared/src/types';

// ---------- HMAC signing ----------

const enc = new TextEncoder();

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin);
}

/**
 * Build the `X-Signature` header for a `${timestamp}\n${body}` payload.
 * Exported so the webhook receiver can re-derive signatures the gateway
 * sent us when fanning out Notion events.
 */
export async function sign(secret: string, ts: number, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}\n${body}`));
  return bytesToBase64(new Uint8Array(sig));
}

export interface GatewayDeps {
  fetcher?: typeof fetch;
  now?: () => number;
}

/**
 * Common HMAC-signed POST helper.  Surfaces gateway errors as thrown
 * Errors whose message includes the status code so callers can decide
 * whether to treat 4xx as "skip" or surface to the user.
 */
export async function signedPost<T>(
  env: Pick<Env, 'NOTION_GATEWAY_URL' | 'NOTION_GATEWAY_CLIENT_ID' | 'NOTION_GATEWAY_SECRET'>,
  path: string,
  body: unknown,
  deps: GatewayDeps = {},
): Promise<T> {
  const ts = (deps.now ?? Date.now)();
  const rawBody = JSON.stringify(body ?? {});
  const sig = await sign(env.NOTION_GATEWAY_SECRET, ts, rawBody);
  const base = env.NOTION_GATEWAY_URL.replace(/\/$/, '');
  const fetcher = deps.fetcher ?? fetch;
  const res = await fetcher(`${base}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Client-Id': env.NOTION_GATEWAY_CLIENT_ID,
      'X-Timestamp': String(ts),
      'X-Signature': sig,
    },
    body: rawBody,
  });
  if (!res.ok) {
    /* v8 ignore next — `res.text()` only rejects on malformed bodies. */
    const text = await res.text().catch(() => '');
    throw new Error(`notion-gateway ${path} ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ---------- High-level helpers (one per gateway endpoint) ----------

export function getOAuthStartUrl(
  env: Env,
  args: { app_resource: string; return_to: string },
  deps?: GatewayDeps,
): Promise<OAuthStartTokenResponse> {
  return signedPost<OAuthStartTokenResponse>(env, '/v1/oauth-start-token', args, deps);
}

export function getConnection(
  env: Env,
  args: { app_resource: string },
  deps?: GatewayDeps,
): Promise<{ connection: GatewayConnection | null }> {
  return signedPost(env, '/v1/connections/get', args, deps);
}

export function listWorkspaces(env: Env, deps?: GatewayDeps): Promise<ListWorkspacesResponse> {
  return signedPost<ListWorkspacesResponse>(env, '/v1/workspaces/list', {}, deps);
}

export function listDatabases(
  env: Env,
  args: { workspace_id: number },
  deps?: GatewayDeps,
): Promise<ListDatabasesResponse> {
  return signedPost<ListDatabasesResponse>(env, '/v1/databases/list', args, deps);
}

export function inspectDatabase(
  env: Env,
  args: { workspace_id: number; database_id: string },
  deps?: GatewayDeps,
): Promise<DatabaseInspectResponse> {
  return signedPost<DatabaseInspectResponse>(env, '/v1/databases/inspect', args, deps);
}

export function upsertConnection(
  env: Env,
  args: {
    app_resource: string;
    workspace_id?: number;
    database_id: string;
    database_title: string;
    mapping: NotionMapping;
  },
  deps?: GatewayDeps,
): Promise<{ connection: GatewayConnection }> {
  return signedPost(env, '/v1/connections/upsert', args, deps);
}

export function disconnectConnection(
  env: Env,
  args: { app_resource: string },
  deps?: GatewayDeps,
): Promise<{ ok: true }> {
  return signedPost(env, '/v1/connections/delete', args, deps);
}

export function pushPage(
  env: Env,
  args: { app_resource: string; app_record: string; fields: Record<string, unknown> },
  deps?: GatewayDeps,
): Promise<PageUpsertResponse> {
  return signedPost<PageUpsertResponse>(env, '/v1/pages/upsert', args, deps);
}

export function deletePage(
  env: Env,
  args: { app_resource: string; app_record: string },
  deps?: GatewayDeps,
): Promise<PageDeleteResponse> {
  return signedPost<PageDeleteResponse>(env, '/v1/pages/delete', args, deps);
}

// ---------- PM-side issue fan-out ----------

/**
 * Hydrate an issue row + the fk-resolved labels the gateway expects on a
 * push.  Returns null when the issue has been deleted between enqueue and
 * execution (the caller treats null as a no-op).
 */
export interface IssueFields {
  subject: string;
  description: string;
  status: string | null;
  tracker: string | null;
  priority: string | null;
  assignedTo: string | null;
  dueDate: string | null;
  startDate: string | null;
  estimatedHours: number | null;
  doneRatio: number;
  category: string | null;
  fixedVersion: string | null;
  createdAt: string;
  pmId: string;
  projectId: number;
}

export async function loadIssueFields(db: DB, issueId: number): Promise<IssueFields | null> {
  const issue = await db.query.issues.findFirst({ where: eq(issues.id, issueId) });
  if (!issue) return null;
  const refData = await getRefData(db);
  const status = refData.statuses.find((s) => s.id === issue.statusId);
  const tracker = refData.trackers.find((t) => t.id === issue.trackerId);
  const priority = refData.priorities.find((p) => p.id === issue.priorityId);
  const [assignee, category, version] = await Promise.all([
    issue.assignedToId
      ? db.query.users.findFirst({ where: eq(users.id, issue.assignedToId) })
      : null,
    issue.categoryId
      ? db.query.issueCategories.findFirst({ where: eq(issueCategories.id, issue.categoryId) })
      : null,
    issue.fixedVersionId
      ? db.query.versions.findFirst({ where: eq(versions.id, issue.fixedVersionId) })
      : null,
  ]);
  return {
    subject: issue.subject,
    description: issue.description,
    /* v8 ignore start — FK constraints guarantee these rows exist. */
    status: status?.name ?? null,
    tracker: tracker?.name ?? null,
    priority: priority?.name ?? null,
    /* v8 ignore stop */
    assignedTo: assignee?.email ?? null,
    dueDate: issue.dueDate ?? null,
    startDate: issue.startDate ?? null,
    estimatedHours: issue.estimatedHours ?? null,
    doneRatio: issue.doneRatio,
    category: category?.name ?? null,
    fixedVersion: version?.name ?? null,
    createdAt: issue.createdAt.toISOString(),
    pmId: `PM-${issue.id}`,
    projectId: issue.projectId,
  };
}

/**
 * Fire-and-forget push of a single PM issue onto its mapped Notion page.
 * The gateway handles the "no connection yet" path (404 -> swallowed
 * here); real network errors are logged.  Always returns synchronously;
 * if `ctx.waitUntil` is available we keep the worker alive long enough to
 * let the push complete.
 */
export function pushIssueBackground(
  env: Env,
  ctx: ExecutionContext | undefined,
  db: DB,
  issueId: number,
  deps: GatewayDeps = {},
): void {
  const work = async () => {
    const fields = await loadIssueFields(db, issueId);
    if (!fields) return;
    const { projectId, ...payload } = fields;
    try {
      await pushPage(
        env,
        {
          app_resource: `project/${projectId}`,
          app_record: `issue/${issueId}`,
          fields: payload as unknown as Record<string, unknown>,
        },
        deps,
      );
    } catch (err) {
      // 404 from the gateway = no connection for this project; treat as
      // benign and stay quiet.  Anything else gets logged.
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes(' 404:')) return;
      console.error('[notion gateway push]', msg);
    }
  };
  if (ctx?.waitUntil) {
    ctx.waitUntil(work());
  } else {
    void work();
  }
}
