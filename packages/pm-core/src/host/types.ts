// PM plugin host — the seam that lets features (and, downstream, tenant-specific
// plugins) hook into the issue lifecycle without the core importing them. Core
// emits events; the host fans them out to registered plugins in order.
//
// The host is composed by the consuming app (allenlabs' app, or a private
// tenant's) and INJECTED into the core impls (createIssueImpl/updateIssueImpl/
// getIssueImpl take a `host` param) — so pm-core never imports an app-side
// singleton, and a deployment chooses its own plugin set.

import type { DB } from '../db/client';
import type { Permission } from '../lib/permissions';
import type { CurrentUser } from '../server/auth';
import type { CreateIssueInput } from '../server/issues';
import type { Issue } from '../db/schema';

/** Threaded into every hook so impls stay pure (no SSR runtime). */
export interface PmContext {
  db: DB;
  /** The acting user, or null for unauthenticated reads (e.g. public-project issue detail). */
  actingUser: CurrentUser | null;
  host: PmHost;
}

export interface BeforeIssueCreateEvent {
  projectId: number;
  input: CreateIssueInput;
}
export interface IssueCreatedEvent {
  issue: Issue;
  input: CreateIssueInput;
}
export interface BeforeIssueUpdateEvent {
  current: Issue;
  /** Accepted field patch about to be applied. */
  patch: Record<string, unknown>;
}
export interface IssueUpdatedEvent {
  before: Issue;
  after: Issue;
  patch: Record<string, unknown>;
  notes: string;
}

/**
 * Mutable accumulator passed to `onIssueDetailLoad`. Feature plugins attach
 * their slice of the issue-detail payload (labels, relations, …) onto it; the
 * core merges it into getIssueImpl's result. Keeping it open is what lets the
 * core read path stay free of any feature import.
 */
export type IssueDetailExtras = Record<string, unknown>;
export interface IssueDetailLoadEvent {
  issue: Issue;
  detail: IssueDetailExtras;
}

/** Maps each hook name to its event payload (used to type `dispatch`). */
export interface HookEventMap {
  onBeforeIssueCreate: BeforeIssueCreateEvent;
  onIssueCreated: IssueCreatedEvent;
  onBeforeIssueUpdate: BeforeIssueUpdateEvent;
  onIssueUpdated: IssueUpdatedEvent;
  onIssueDetailLoad: IssueDetailLoadEvent;
}
export type HookName = keyof HookEventMap;

export type PmHooks = {
  [K in HookName]?: (ctx: PmContext, event: HookEventMap[K]) => Promise<void>;
};

export interface PmPlugin {
  id: string;
  dependsOn?: string[];
  hooks?: PmHooks;
  /** Permission keys this plugin introduces (reserved for later stages). */
  permissions?: Permission[];
}

export interface PmHost {
  /** Fan an event out to every plugin subscribed to `name`, in registration order. */
  dispatch<K extends HookName>(name: K, ctx: PmContext, event: HookEventMap[K]): Promise<void>;
  /** Whether a plugin id is registered (for graceful cross-feature degradation). */
  has(id: string): boolean;
  readonly pluginIds: readonly string[];
}

export function definePmPlugin(p: PmPlugin): PmPlugin {
  return p;
}
