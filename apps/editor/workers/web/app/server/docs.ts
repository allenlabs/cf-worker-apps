// Server functions wrapping the editor-api HMAC client. Each one injects the
// current user (from the verified JWT) into the signed body, so the backend
// can trust `userId` / `userName` after HMAC verification.
//
// Convention (matches project-management): pure `*Impl(env, user, input)`
// helpers carry the logic + are unit-testable; the createServerFn wrappers are
// thin shells wrapped in `/* v8 ignore start/stop */` (covered by integration
// tests against the running worker).

import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { apiPostImpl, type ApiClientDeps, type ApiClientEnv } from '~/lib/api-client';
import { getEnv, requireUser, type CurrentUser } from './auth-runtime.server';

export interface DocListItem {
  id: string;
  title: string;
  updatedAt: string;
}

export interface DocFull {
  id: string;
  title: string;
  snapshotHtml: string;
  ownerId: string;
}

export interface MentionResult {
  id: string;
  label: string;
}

export interface CollabToken {
  token: string;
  url: string;
  docId: string;
}

// ---------- workspaces + page tree (Phase 1) ----------

export interface Workspace {
  id: string;
  name: string;
}

export interface PageNode {
  id: string;
  title: string;
  icon: string | null;
  parentId: string | null;
  position: number;
  kind: string; // 'page' | 'database'
  teamspaceId: string | null; // Phase 9 — grouping; null == "Private"
}

export type PageRole = 'owner' | 'edit' | 'view';

export interface PageFull {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  cover: string | null; // Phase 11 — optional banner image URL (null == none)
  snapshotHtml: string;
  kind: string; // 'page' | 'database'
  databaseId: string | null;
  public: boolean; // Phase 4 — public share toggle state
  favorited: boolean; // Phase 4 — starred by the requesting user
  role: PageRole; // Phase 9 — requesting user's effective role on this page
  restricted: boolean; // Phase 10 — only owner + invited people can access
  fullWidth: boolean; // Phase 14 — render the page container edge-to-edge
  locked: boolean; // Phase 14 — read-only for everyone when true
  isWiki: boolean; // Phase 15 — page is a wiki home (directory of sub-pages)
  verified: boolean; // Phase 15 — marked verified
  verifiedBy: string | null; // Phase 15 — who verified
  verifiedAt: string | null; // Phase 15 — when verified (ISO)
}

// ---------- per-user sharing + teamspaces (Phase 9) ----------

export type ShareRole = 'view' | 'edit';

export interface SharedUser {
  userId: string;
  name: string;
  role: ShareRole;
}

export interface SharedWithMeItem {
  id: string;
  title: string;
  icon: string | null;
}

export interface Teamspace {
  id: string;
  name: string;
}

export interface TeamspaceMember {
  userId: string;
  name: string;
  role: string;
}

// ---------- collaboration (Phase 4) ----------

export interface FavoriteItem {
  pageId: string;
  title: string;
  icon: string | null;
}

export interface TrashItem {
  id: string;
  title: string;
  icon: string | null;
}

export interface SearchResult {
  id: string;
  title: string;
  icon: string | null;
  workspaceId: string;
}

export interface PublicPage {
  title: string;
  icon: string | null;
  snapshotHtml: string;
}

export interface CommentItem {
  id: string;
  /** null = page-level comment; non-null = inline (text-anchored) thread. */
  threadId: string | null;
  authorName: string;
  body: string;
  resolved: boolean;
  createdAt: string;
  /** Phase 16 — emails @-mentioned in the comment body. */
  mentions: string[];
}

// ---------- Phase 16 — backlinks / notifications / reminders / reactions ----------

export interface BacklinkItem {
  id: string;
  title: string;
  icon: string | null;
  updatedAt: string;
}

export type NotificationKind = 'mention' | 'comment' | 'reminder' | 'reaction';

export interface NotificationItem {
  id: string;
  kind: NotificationKind;
  pageId: string | null;
  pageTitle: string | null;
  commentId: string | null;
  actor: string | null;
  body: string | null;
  read: boolean;
  createdAt: string;
}

export interface ReminderItem {
  id: string;
  pageId: string;
  remindAt: string;
  body: string | null;
  fired: boolean;
  createdAt: string;
}

export interface ReactionGroup {
  emoji: string;
  count: number;
  users: string[];
  mine: boolean;
}

export interface ThreadSummary {
  threadId: string;
  snippet: string;
  count: number;
}

// ---------- databases (Phase 3) ----------

/**
 * JSON-serializable value. TanStack Start's createServerFn validates that
 * return types are serializable, which rejects `unknown` — so cell values and
 * jsonb config use this recursive JSON type instead.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PropertyType =
  | 'text'
  | 'number'
  | 'checkbox'
  | 'select'
  | 'multi_select'
  | 'status'
  | 'date'
  | 'url'
  | 'email'
  | 'phone'
  | 'person'
  | 'files'
  | 'relation'
  | 'rollup'
  | 'formula'
  | 'created_time'
  | 'created_by'
  | 'last_edited_time'
  | 'last_edited_by';

/** Read-only property types derived from the row page (not stored in props). */
export const AUTO_PROPERTY_TYPES = new Set<string>([
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
]);

export type ViewType = 'table' | 'board' | 'list' | 'gallery' | 'calendar' | 'timeline';

/** A {url,name} entry for a `files` property value. */
export interface FileRef {
  url: string;
  name: string;
}

export interface SelectOption {
  id: string;
  name: string;
  color?: string;
}

export interface DbPropertyConfig {
  options?: SelectOption[];
  [k: string]: JsonValue | SelectOption[] | undefined;
}

export interface DbProperty {
  id: string;
  databaseId: string;
  name: string;
  type: string;
  config: DbPropertyConfig;
  position: number;
}

// Phase 15: filter / sort / group builder model (mirrors db-filter.ts on the api).
export type FilterConjunction = 'and' | 'or';

export type FilterOp =
  | 'contains'
  | 'not_contains'
  | 'equals'
  | 'not_equals'
  | 'is_empty'
  | 'is_not_empty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'is'
  | 'is_not'
  | 'has'
  | 'has_not'
  | 'checked'
  | 'unchecked'
  | 'before'
  | 'after'
  | 'on'
  | 'within_days';

export interface FilterCondition {
  propId: string;
  op: FilterOp;
  value?: JsonValue;
}

export interface FilterGroup {
  conjunction: FilterConjunction;
  conditions: (FilterCondition | FilterGroup)[];
}

export interface DbViewConfig {
  filters?: { propId: string; op?: string; value?: JsonValue }[]; // legacy flat
  filterGroup?: FilterGroup; // Phase 15: nested AND/OR group
  sorts?: { propId: string; dir?: 'asc' | 'desc' }[];
  groupBy?: string; // board + Phase 15 table grouping: select/status prop
  datePropId?: string; // calendar/timeline: date prop to place rows by
  cardPropId?: string; // gallery: prop shown as the card preview
  visible?: string[];
  subItemsEnabled?: boolean; // Phase 15: nest sub-item rows in table view
}

export interface DbView {
  id: string;
  databaseId: string;
  name: string;
  type: string; // 'table' | 'board'
  config: DbViewConfig;
  position: number;
  sourceDatabaseId: string | null; // Phase 15: linked view reads this DB's rows
}

export interface DbSchema {
  database: { id: string; title: string };
  properties: DbProperty[];
  views: DbView[];
}

/** Auto/meta fields derived from the row page (created/last-edited cells). */
export interface DbRowMeta {
  createdTime: string;
  lastEditedTime: string;
  createdById: string | null;
  createdByName: string | null;
}

/** A relation target resolved to a renderable chip (Phase 6). */
export interface RelationChip {
  id: string;
  title: string;
  icon?: string | null;
}

/** A workspace database (kind='database' page), for relation target pickers. */
export interface DatabaseListItem {
  id: string;
  title: string;
}

export interface DbRow {
  id: string;
  title: string;
  props: Record<string, JsonValue>;
  meta: DbRowMeta;
  // Phase 6: relation prop id → resolved chips (parallel to props, which holds
  // the raw string[] of ids). Only present for relation props.
  relations?: Record<string, RelationChip[]>;
  // Phase 6: rollup prop id → read-only computed value.
  rollups?: Record<string, JsonValue>;
  // Phase 7: formula prop id → read-only computed value (or { __error } sentinel).
  formulas?: Record<string, JsonValue>;
  // Phase 15: this row's parent row WITHIN the same DB (sub-items), or null.
  subItemParentId?: string | null;
}

/** Phase 15 — a database's row template (hidden seed page). */
export interface DbTemplate {
  id: string;
  title: string;
}

/** Phase 15 — one child page in a wiki directory listing. */
export interface WikiEntry {
  id: string;
  title: string;
  icon: string | null;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  updatedAt: string;
}

// ---------- page version history (Phase 5) ----------

export interface VersionMeta {
  id: string;
  authorName: string | null;
  createdAt: string;
}

export interface VersionContent {
  snapshotHtml: string;
}

/** Fields the backend's HMAC layer trusts after verifying the signature. */
function userBody(user: CurrentUser, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: user.id,
    userName: user.name,
    username: user.username,
    // Phase 16 — forward the SSO email so the API can key notifications per
    // user (it falls back to userId when absent).
    email: user.email,
    ...extra,
  };
}

// ---------- impls (testable; inject env + fetcher) ----------

export function listDocsImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  deps?: ApiClientDeps,
): Promise<DocListItem[]> {
  return apiPostImpl<DocListItem[]>(env, '/v1/docs/list', userBody(user), deps);
}

export function createDocImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  title: string,
  deps?: ApiClientDeps,
): Promise<{ id: string; title: string }> {
  return apiPostImpl<{ id: string; title: string }>(
    env,
    '/v1/docs/create',
    userBody(user, { title }),
    deps,
  );
}

export function getDocImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<DocFull> {
  return apiPostImpl<DocFull>(env, '/v1/docs/get', userBody(user, { id }), deps);
}

export function updateDocImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; title?: string; snapshotHtml?: string },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/docs/update', userBody(user, input), deps);
}

export function deleteDocImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/docs/delete', userBody(user, { id }), deps);
}

export function searchUsersImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  q: string,
  deps?: ApiClientDeps,
): Promise<MentionResult[]> {
  return apiPostImpl<MentionResult[]>(env, '/v1/users/search', userBody(user, { q }), deps);
}

export function collabTokenImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  docId: string,
  deps?: ApiClientDeps,
): Promise<CollabToken> {
  return apiPostImpl<CollabToken>(env, '/v1/collab-token', userBody(user, { docId }), deps);
}

export function listWorkspacesImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  deps?: ApiClientDeps,
): Promise<Workspace[]> {
  return apiPostImpl<Workspace[]>(env, '/v1/workspaces/list', userBody(user), deps);
}

export function getTreeImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  workspaceId: string,
  deps?: ApiClientDeps,
): Promise<PageNode[]> {
  return apiPostImpl<PageNode[]>(env, '/v1/pages/tree', userBody(user, { workspaceId }), deps);
}

export function createPageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: {
    workspaceId: string;
    parentId?: string | null;
    title?: string;
    icon?: string | null;
    teamspaceId?: string | null;
  },
  deps?: ApiClientDeps,
): Promise<{ id: string; title: string; parentId: string | null }> {
  return apiPostImpl<{ id: string; title: string; parentId: string | null }>(
    env,
    '/v1/pages/create',
    userBody(user, input),
    deps,
  );
}

export function getPageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<PageFull> {
  return apiPostImpl<PageFull>(env, '/v1/pages/get', userBody(user, { id }), deps);
}

export function updatePageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: {
    id: string;
    title?: string;
    icon?: string | null;
    cover?: string | null;
    snapshotHtml?: string;
    fullWidth?: boolean;
  },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/pages/update', userBody(user, input), deps);
}

/** Phase 14 — deep-copy a page subtree; returns the new root id. */
export function duplicatePageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ id: string }> {
  return apiPostImpl<{ id: string }>(env, '/v1/pages/duplicate', userBody(user, { id }), deps);
}

/** Phase 14 — toggle a page's read-only lock (owner/editor). */
export function setLockedImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; locked: boolean },
  deps?: ApiClientDeps,
): Promise<{ locked: boolean }> {
  return apiPostImpl<{ locked: boolean }>(env, '/v1/pages/set-locked', userBody(user, input), deps);
}

export function movePageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; parentId?: string | null; position?: number },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/pages/move', userBody(user, input), deps);
}

export function archivePageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/pages/archive', userBody(user, { id }), deps);
}

export function uploadFileImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { filename: string; contentType: string; dataBase64: string },
  deps?: ApiClientDeps,
): Promise<{ url: string; key: string }> {
  return apiPostImpl<{ url: string; key: string }>(
    env,
    '/v1/files/upload',
    userBody(user, input),
    deps,
  );
}

// ---------- database impls (Phase 3) ----------

export function dbCreateImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { workspaceId: string; parentId?: string | null; title?: string },
  deps?: ApiClientDeps,
): Promise<{ id: string }> {
  return apiPostImpl<{ id: string }>(env, '/v1/db/create', userBody(user, input), deps);
}

export function dbSchemaImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  databaseId: string,
  deps?: ApiClientDeps,
): Promise<DbSchema> {
  return apiPostImpl<DbSchema>(env, '/v1/db/schema', userBody(user, { databaseId }), deps);
}

export function propAddImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { databaseId: string; name: string; type: PropertyType; config?: Record<string, unknown> },
  deps?: ApiClientDeps,
): Promise<DbProperty> {
  return apiPostImpl<DbProperty>(env, '/v1/db/property/add', userBody(user, input), deps);
}

export function propUpdateImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; name?: string; type?: PropertyType; config?: Record<string, unknown> },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/property/update', userBody(user, input), deps);
}

export function propDeleteImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/property/delete', userBody(user, { id }), deps);
}

export function viewAddImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: {
    databaseId: string;
    type: ViewType;
    name?: string;
    config?: Record<string, unknown>;
    sourceDatabaseId?: string | null;
  },
  deps?: ApiClientDeps,
): Promise<DbView> {
  return apiPostImpl<DbView>(env, '/v1/db/view/add', userBody(user, input), deps);
}

export function viewUpdateImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; name?: string; config?: Record<string, unknown>; sourceDatabaseId?: string | null },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/view/update', userBody(user, input), deps);
}

export function viewDeleteImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/view/delete', userBody(user, { id }), deps);
}

export function dbRowsImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { databaseId: string; viewId?: string; sourceDatabaseId?: string | null },
  deps?: ApiClientDeps,
): Promise<DbRow[]> {
  return apiPostImpl<DbRow[]>(env, '/v1/db/rows', userBody(user, input), deps);
}

export function rowAddImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { databaseId: string; title?: string; templateId?: string | null; subItemParentId?: string | null },
  deps?: ApiClientDeps,
): Promise<DbRow> {
  return apiPostImpl<DbRow>(env, '/v1/db/row/add', userBody(user, input), deps);
}

/** Phase 15 — set/clear a row's sub-item parent (cycle-guarded server-side). */
export function rowSetSubItemImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; parentId: string | null },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/row/set-sub-item', userBody(user, input), deps);
}

// ---------- row templates + wiki/verify impls (Phase 15) ----------

export function templatesListImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  databaseId: string,
  deps?: ApiClientDeps,
): Promise<DbTemplate[]> {
  return apiPostImpl<DbTemplate[]>(env, '/v1/db/templates/list', userBody(user, { databaseId }), deps);
}

export function templateCreateImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { databaseId: string; name?: string },
  deps?: ApiClientDeps,
): Promise<DbTemplate> {
  return apiPostImpl<DbTemplate>(env, '/v1/db/templates/create', userBody(user, input), deps);
}

export function templateRenameImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; name: string },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/templates/rename', userBody(user, input), deps);
}

export function templateDeleteImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/templates/delete', userBody(user, { id }), deps);
}

export function setWikiImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; isWiki: boolean },
  deps?: ApiClientDeps,
): Promise<{ isWiki: boolean }> {
  return apiPostImpl<{ isWiki: boolean }>(env, '/v1/pages/set-wiki', userBody(user, input), deps);
}

export function verifyPageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; verified: boolean },
  deps?: ApiClientDeps,
): Promise<{ verified: boolean; verifiedBy: string | null; verifiedAt: string | null }> {
  return apiPostImpl<{ verified: boolean; verifiedBy: string | null; verifiedAt: string | null }>(
    env,
    '/v1/pages/verify',
    userBody(user, input),
    deps,
  );
}

export function wikiEntriesImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<WikiEntry[]> {
  return apiPostImpl<WikiEntry[]>(env, '/v1/pages/wiki-entries', userBody(user, { id }), deps);
}

export function rowUpdateImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; title?: string; props?: Record<string, unknown> },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/row/update', userBody(user, input), deps);
}

export function rowDeleteImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/db/row/delete', userBody(user, { id }), deps);
}

// ---------- relation / rollup impls (Phase 6) ----------

/** List the workspace's databases (relation target picker). */
export function dbListImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  workspaceId: string,
  deps?: ApiClientDeps,
): Promise<DatabaseListItem[]> {
  return apiPostImpl<DatabaseListItem[]>(env, '/v1/db/list', userBody(user, { workspaceId }), deps);
}

/** Search a target database's rows for the relation cell picker. */
export function relatedRowsImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { databaseId: string; q?: string },
  deps?: ApiClientDeps,
): Promise<RelationChip[]> {
  return apiPostImpl<RelationChip[]>(env, '/v1/db/related-rows', userBody(user, input), deps);
}

// ---------- collaboration impls (Phase 4) ----------

export function favListImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  deps?: ApiClientDeps,
): Promise<FavoriteItem[]> {
  return apiPostImpl<FavoriteItem[]>(env, '/v1/fav/list', userBody(user), deps);
}

export function favToggleImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  pageId: string,
  deps?: ApiClientDeps,
): Promise<{ favorited: boolean }> {
  return apiPostImpl<{ favorited: boolean }>(env, '/v1/fav/toggle', userBody(user, { pageId }), deps);
}

export function pagesTrashImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  workspaceId: string,
  deps?: ApiClientDeps,
): Promise<TrashItem[]> {
  return apiPostImpl<TrashItem[]>(env, '/v1/pages/trash', userBody(user, { workspaceId }), deps);
}

export function pageRestoreImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/pages/restore', userBody(user, { id }), deps);
}

export function pagePurgeImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/pages/purge', userBody(user, { id }), deps);
}

export function searchImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  q: string,
  deps?: ApiClientDeps,
): Promise<SearchResult[]> {
  return apiPostImpl<SearchResult[]>(env, '/v1/search', userBody(user, { q }), deps);
}

export function setPublicImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; public: boolean },
  deps?: ApiClientDeps,
): Promise<{ public: boolean }> {
  return apiPostImpl<{ public: boolean }>(env, '/v1/pages/setPublic', userBody(user, input), deps);
}

/**
 * NO-AUTH public read. Hits the editor-api public route directly (GET, no HMAC
 * signature, no user body) so the share route is reachable signed-out.
 */
export async function publicPageImpl(
  env: Pick<ApiClientEnv, 'EDITOR_API_URL'>,
  id: string,
  deps?: ApiClientDeps,
): Promise<PublicPage | null> {
  const base = env.EDITOR_API_URL.replace(/\/$/, '');
  /* v8 ignore next — real fetch is the production default; tests inject one. */
  const fetcher = deps?.fetcher ?? fetch;
  const res = await fetcher(`${base}/public/page/${encodeURIComponent(id)}`, { method: 'GET' });
  if (res.status === 404) return null;
  /* v8 ignore next 3 — only on unexpected upstream failure. */
  if (!res.ok) {
    throw new Error(`editor-api /public/page ${res.status}`);
  }
  return (await res.json()) as PublicPage;
}

export function commentsListImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { pageId: string; threadId?: string },
  deps?: ApiClientDeps,
): Promise<CommentItem[]> {
  return apiPostImpl<CommentItem[]>(env, '/v1/comments/list', userBody(user, input), deps);
}

/** Distinct open inline threads on a page (snippet + count). */
export function commentThreadsImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  pageId: string,
  deps?: ApiClientDeps,
): Promise<ThreadSummary[]> {
  return apiPostImpl<ThreadSummary[]>(env, '/v1/comments/threads', userBody(user, { pageId }), deps);
}

export function commentAddImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { pageId: string; body: string; threadId?: string | null },
  deps?: ApiClientDeps,
): Promise<CommentItem> {
  return apiPostImpl<CommentItem>(env, '/v1/comments/add', userBody(user, input), deps);
}

export function commentResolveImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input:
    | { id: string; resolved: boolean }
    | { pageId: string; threadId: string; resolved: boolean },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/comments/resolve', userBody(user, input), deps);
}

export function commentDeleteImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/comments/delete', userBody(user, { id }), deps);
}

// ---------- Phase 16 impls (testable; inject env + fetcher) ----------

export function backlinksImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  pageId: string,
  deps?: ApiClientDeps,
): Promise<BacklinkItem[]> {
  return apiPostImpl<BacklinkItem[]>(env, '/v1/pages/backlinks', userBody(user, { pageId }), deps);
}

export function notificationsListImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  limit?: number,
  deps?: ApiClientDeps,
): Promise<NotificationItem[]> {
  return apiPostImpl<NotificationItem[]>(
    env,
    '/v1/notifications/list',
    userBody(user, limit === undefined ? {} : { limit }),
    deps,
  );
}

export function unreadCountImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  deps?: ApiClientDeps,
): Promise<{ count: number }> {
  return apiPostImpl<{ count: number }>(env, '/v1/notifications/unread-count', userBody(user), deps);
}

export function markReadImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id?: string; all?: boolean },
  deps?: ApiClientDeps,
): Promise<{ updated: number }> {
  return apiPostImpl<{ updated: number }>(
    env,
    '/v1/notifications/mark-read',
    userBody(user, input),
    deps,
  );
}

export function reminderAddImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { pageId: string; remindAt: string; body?: string | null },
  deps?: ApiClientDeps,
): Promise<ReminderItem> {
  return apiPostImpl<ReminderItem>(env, '/v1/reminders/add', userBody(user, input), deps);
}

export function remindersListImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  pageId: string,
  deps?: ApiClientDeps,
): Promise<ReminderItem[]> {
  return apiPostImpl<ReminderItem[]>(env, '/v1/reminders/list', userBody(user, { pageId }), deps);
}

export function reminderCancelImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/reminders/cancel', userBody(user, { id }), deps);
}

export function reactImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { commentId: string; emoji: string },
  deps?: ApiClientDeps,
): Promise<{ added: boolean }> {
  return apiPostImpl<{ added: boolean }>(env, '/v1/comments/react', userBody(user, input), deps);
}

export function reactionsForCommentsImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  commentIds: string[],
  deps?: ApiClientDeps,
): Promise<Record<string, ReactionGroup[]>> {
  return apiPostImpl<Record<string, ReactionGroup[]>>(
    env,
    '/v1/comments/reactions',
    userBody(user, { commentIds }),
    deps,
  );
}

// ---------- version history impls (Phase 5) ----------

export function versionsListImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  pageId: string,
  deps?: ApiClientDeps,
): Promise<VersionMeta[]> {
  return apiPostImpl<VersionMeta[]>(env, '/v1/pages/versions', userBody(user, { pageId }), deps);
}

export function versionGetImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<VersionContent> {
  return apiPostImpl<VersionContent>(env, '/v1/pages/versions/get', userBody(user, { id }), deps);
}

export function versionRestoreImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/pages/versions/restore', userBody(user, { id }), deps);
}

// ---------- per-user sharing + teamspaces impls (Phase 9) ----------

export function shareePageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { pageId: string; query: string; role: ShareRole },
  deps?: ApiClientDeps,
): Promise<SharedUser> {
  return apiPostImpl<SharedUser>(env, '/v1/pages/share', userBody(user, input), deps);
}

export function unsharePageImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { pageId: string; userId: string },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/pages/unshare', userBody(user, input), deps);
}

export function pageSharesImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  pageId: string,
  deps?: ApiClientDeps,
): Promise<SharedUser[]> {
  return apiPostImpl<SharedUser[]>(env, '/v1/pages/shares', userBody(user, { pageId }), deps);
}

export function sharedWithMeImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  deps?: ApiClientDeps,
): Promise<SharedWithMeItem[]> {
  return apiPostImpl<SharedWithMeItem[]>(env, '/v1/pages/shared-with-me', userBody(user), deps);
}

export function teamspacesListImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  workspaceId: string,
  deps?: ApiClientDeps,
): Promise<Teamspace[]> {
  return apiPostImpl<Teamspace[]>(env, '/v1/teamspaces/list', userBody(user, { workspaceId }), deps);
}

export function teamspaceCreateImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { workspaceId: string; name?: string },
  deps?: ApiClientDeps,
): Promise<Teamspace> {
  return apiPostImpl<Teamspace>(env, '/v1/teamspaces/create', userBody(user, input), deps);
}

export function teamspaceRenameImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; name: string },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/teamspaces/rename', userBody(user, input), deps);
}

export function teamspaceDeleteImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  id: string,
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/teamspaces/delete', userBody(user, { id }), deps);
}

// ---------- per-page restriction + teamspace members (Phase 10) ----------

export function setRestrictedImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; restricted: boolean },
  deps?: ApiClientDeps,
): Promise<{ restricted: boolean }> {
  return apiPostImpl<{ restricted: boolean }>(
    env,
    '/v1/pages/set-restricted',
    userBody(user, input),
    deps,
  );
}

export function teamspaceMembersImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  teamspaceId: string,
  deps?: ApiClientDeps,
): Promise<TeamspaceMember[]> {
  return apiPostImpl<TeamspaceMember[]>(
    env,
    '/v1/teamspaces/members',
    userBody(user, { teamspaceId }),
    deps,
  );
}

export function teamspaceMemberAddImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { teamspaceId: string; query: string; role?: 'member' | 'admin' },
  deps?: ApiClientDeps,
): Promise<TeamspaceMember> {
  return apiPostImpl<TeamspaceMember>(
    env,
    '/v1/teamspaces/member/add',
    userBody(user, input),
    deps,
  );
}

export function teamspaceMemberRemoveImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { teamspaceId: string; userId: string },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(
    env,
    '/v1/teamspaces/member/remove',
    userBody(user, input),
    deps,
  );
}

// ---------- createServerFn wrappers ----------
/* v8 ignore start */

export const listDocs = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser();
  return listDocsImpl(getEnv(), user);
});

export const createDoc = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ title: z.string().max(255).optional() }).parse(d))
  .handler(async ({ data }) => {
      const user = await requireUser();
    return createDocImpl(getEnv(), user, data.title ?? 'Untitled');
  });

export const getDoc = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
      const user = await requireUser();
    return getDocImpl(getEnv(), user, data.id);
  });

export const updateDoc = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        title: z.string().max(255).optional(),
        snapshotHtml: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
      const user = await requireUser();
    return updateDocImpl(getEnv(), user, data);
  });

export const deleteDoc = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
      const user = await requireUser();
    return deleteDocImpl(getEnv(), user, data.id);
  });

export const searchMentions = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ q: z.string().default('') }).parse(d))
  .handler(async ({ data }) => {
      const user = await requireUser();
    return searchUsersImpl(getEnv(), user, data.q);
  });

export const collabToken = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ docId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
      const user = await requireUser();
    return collabTokenImpl(getEnv(), user, data.docId);
  });

// Phase 12: mint a collab token for an arbitrary synced-block room
// (`sync-<uuid>`). Mirrors `collabToken` but for a room string rather than a
// page id — the editor-api gates this on the verified user having ≥1 workspace
// membership (the room is self-describing). Used by the editor's `syncedBlock`
// hook so each nested block can connect to its shared room.
const SYNC_ROOM_RE = /^sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const syncRoomToken = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ room: z.string().regex(SYNC_ROOM_RE, 'must be a sync-<uuid> room') }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return collabTokenImpl(getEnv(), user, data.room);
  });

// ---------- workspaces + page tree wrappers (Phase 1) ----------

export const listWorkspaces = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser();
  return listWorkspacesImpl(getEnv(), user);
});

export const getTree = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return getTreeImpl(getEnv(), user, data.workspaceId);
  });

export const createPage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        parentId: z.string().uuid().nullish(),
        title: z.string().max(255).optional(),
        icon: z.string().max(32).nullish(),
        teamspaceId: z.string().uuid().nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return createPageImpl(getEnv(), user, {
      workspaceId: data.workspaceId,
      parentId: data.parentId ?? null,
      title: data.title,
      icon: data.icon ?? null,
      teamspaceId: data.teamspaceId ?? null,
    });
  });

export const getPage = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return getPageImpl(getEnv(), user, data.id);
  });

export const updatePage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        title: z.string().max(255).optional(),
        icon: z.string().max(32).nullish(),
        cover: z.string().max(2048).nullish(),
        snapshotHtml: z.string().optional(),
        fullWidth: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return updatePageImpl(getEnv(), user, {
      id: data.id,
      title: data.title,
      icon: data.icon === undefined ? undefined : data.icon ?? null,
      cover: data.cover === undefined ? undefined : data.cover ?? null,
      snapshotHtml: data.snapshotHtml,
      fullWidth: data.fullWidth,
    });
  });

export const duplicatePage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return duplicatePageImpl(getEnv(), user, data.id);
  });

export const setLocked = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), locked: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return setLockedImpl(getEnv(), user, data);
  });

export const movePage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        parentId: z.string().uuid().nullish(),
        position: z.number().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return movePageImpl(getEnv(), user, {
      id: data.id,
      parentId: data.parentId === undefined ? undefined : data.parentId ?? null,
      position: data.position,
    });
  });

export const archivePage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return archivePageImpl(getEnv(), user, data.id);
  });

// Image upload — the client reads File→base64 and posts it here; we inject the
// verified user and forward to editor-api, returning the public URL.
export const uploadFile = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        filename: z.string().max(255).default('image'),
        contentType: z.string().min(1).max(128),
        dataBase64: z.string().min(1),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return uploadFileImpl(getEnv(), user, data);
  });

// ---------- database wrappers (Phase 3) ----------

const propertyTypeSchema = z.enum([
  'text',
  'number',
  'checkbox',
  'select',
  'multi_select',
  'status',
  'date',
  'url',
  'email',
  'phone',
  'person',
  'files',
  'relation',
  'rollup',
  'formula',
  'created_time',
  'created_by',
  'last_edited_time',
  'last_edited_by',
]);

const viewTypeSchema = z.enum(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']);

export const dbCreate = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        workspaceId: z.string().uuid(),
        parentId: z.string().uuid().nullish(),
        title: z.string().max(255).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return dbCreateImpl(getEnv(), user, {
      workspaceId: data.workspaceId,
      parentId: data.parentId ?? null,
      title: data.title,
    });
  });

export const dbSchema = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ databaseId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return dbSchemaImpl(getEnv(), user, data.databaseId);
  });

export const propAdd = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        databaseId: z.string().uuid(),
        name: z.string().min(1).max(120),
        type: propertyTypeSchema,
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return propAddImpl(getEnv(), user, data);
  });

export const propUpdate = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().min(1).max(120).optional(),
        type: propertyTypeSchema.optional(),
        config: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return propUpdateImpl(getEnv(), user, data);
  });

export const propDelete = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return propDeleteImpl(getEnv(), user, data.id);
  });

export const viewAdd = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        databaseId: z.string().uuid(),
        type: viewTypeSchema,
        name: z.string().max(120).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        sourceDatabaseId: z.string().uuid().nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return viewAddImpl(getEnv(), user, data);
  });

export const viewUpdate = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        name: z.string().max(120).optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        sourceDatabaseId: z.string().uuid().nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return viewUpdateImpl(getEnv(), user, data);
  });

export const viewDelete = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return viewDeleteImpl(getEnv(), user, data.id);
  });

export const dbRows = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z
      .object({
        databaseId: z.string().uuid(),
        viewId: z.string().uuid().optional(),
        sourceDatabaseId: z.string().uuid().nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return dbRowsImpl(getEnv(), user, data);
  });

export const rowAdd = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        databaseId: z.string().uuid(),
        title: z.string().max(255).optional(),
        templateId: z.string().uuid().nullish(),
        subItemParentId: z.string().uuid().nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return rowAddImpl(getEnv(), user, data);
  });

export const rowSetSubItem = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), parentId: z.string().uuid().nullable() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return rowSetSubItemImpl(getEnv(), user, data);
  });

export const templatesList = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ databaseId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return templatesListImpl(getEnv(), user, data.databaseId);
  });

export const templateCreate = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ databaseId: z.string().uuid(), name: z.string().max(120).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return templateCreateImpl(getEnv(), user, data);
  });

export const templateRename = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), name: z.string().min(1).max(120) }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return templateRenameImpl(getEnv(), user, data);
  });

export const templateDelete = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return templateDeleteImpl(getEnv(), user, data.id);
  });

export const setWiki = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid(), isWiki: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return setWikiImpl(getEnv(), user, data);
  });

export const verifyPage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), verified: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return verifyPageImpl(getEnv(), user, data);
  });

export const wikiEntries = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return wikiEntriesImpl(getEnv(), user, data.id);
  });

export const rowUpdate = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        id: z.string().uuid(),
        title: z.string().max(255).optional(),
        props: z.record(z.string(), z.unknown()).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return rowUpdateImpl(getEnv(), user, data);
  });

export const rowDelete = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return rowDeleteImpl(getEnv(), user, data.id);
  });

// ---------- relation / rollup wrappers (Phase 6) ----------

export const dbList = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return dbListImpl(getEnv(), user, data.workspaceId);
  });

export const relatedRows = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z.object({ databaseId: z.string().uuid(), q: z.string().max(255).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return relatedRowsImpl(getEnv(), user, data);
  });

// ---------- collaboration wrappers (Phase 4) ----------

export const favList = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser();
  return favListImpl(getEnv(), user);
});

export const favToggle = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ pageId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return favToggleImpl(getEnv(), user, data.pageId);
  });

export const pagesTrash = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return pagesTrashImpl(getEnv(), user, data.workspaceId);
  });

export const pageRestore = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return pageRestoreImpl(getEnv(), user, data.id);
  });

export const pagePurge = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return pagePurgeImpl(getEnv(), user, data.id);
  });

export const search = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ q: z.string().default('') }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return searchImpl(getEnv(), user, data.q);
  });

export const setPublic = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), public: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return setPublicImpl(getEnv(), user, data);
  });

// NO-AUTH: backs the public /share/$pageId route. Does not call requireUser so
// it works for signed-out visitors; the api enforces public=true.
export const publicPage = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    return publicPageImpl(getEnv(), data.id);
  });

export const commentsList = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z.object({ pageId: z.string().uuid(), threadId: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return commentsListImpl(getEnv(), user, data);
  });

export const commentThreads = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ pageId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return commentThreadsImpl(getEnv(), user, data.pageId);
  });

export const commentAdd = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        pageId: z.string().uuid(),
        threadId: z.string().uuid().nullish(),
        body: z.string().min(1).max(10000),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return commentAddImpl(getEnv(), user, data);
  });

export const commentResolve = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .union([
        z.object({ id: z.string().uuid(), resolved: z.boolean() }),
        z.object({
          pageId: z.string().uuid(),
          threadId: z.string().uuid(),
          resolved: z.boolean(),
        }),
      ])
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return commentResolveImpl(getEnv(), user, data);
  });

export const commentDelete = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return commentDeleteImpl(getEnv(), user, data.id);
  });

// ---------- version history wrappers (Phase 5) ----------

export const versionsList = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ pageId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return versionsListImpl(getEnv(), user, data.pageId);
  });

export const versionGet = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return versionGetImpl(getEnv(), user, data.id);
  });

export const versionRestore = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return versionRestoreImpl(getEnv(), user, data.id);
  });

// ---------- per-user sharing + teamspaces wrappers (Phase 9) ----------

export const sharePage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        pageId: z.string().uuid(),
        query: z.string().min(1).max(255),
        role: z.enum(['view', 'edit']).default('view'),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return shareePageImpl(getEnv(), user, data);
  });

export const unsharePage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ pageId: z.string().uuid(), userId: z.string().min(1) }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return unsharePageImpl(getEnv(), user, data);
  });

export const pageShares = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ pageId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return pageSharesImpl(getEnv(), user, data.pageId);
  });

export const sharedWithMe = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser();
  return sharedWithMeImpl(getEnv(), user);
});

export const teamspacesList = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ workspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return teamspacesListImpl(getEnv(), user, data.workspaceId);
  });

export const teamspaceCreate = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ workspaceId: z.string().uuid(), name: z.string().max(120).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return teamspaceCreateImpl(getEnv(), user, data);
  });

export const teamspaceRename = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), name: z.string().min(1).max(120) }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return teamspaceRenameImpl(getEnv(), user, data);
  });

export const teamspaceDelete = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return teamspaceDeleteImpl(getEnv(), user, data.id);
  });

// ---------- per-page restriction + teamspace members wrappers (Phase 10) ----------

export const setRestricted = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), restricted: z.boolean() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return setRestrictedImpl(getEnv(), user, data);
  });

export const teamspaceMembers = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ teamspaceId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return teamspaceMembersImpl(getEnv(), user, data.teamspaceId);
  });

export const teamspaceMemberAdd = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        teamspaceId: z.string().uuid(),
        query: z.string().min(1).max(255),
        role: z.enum(['member', 'admin']).default('member'),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return teamspaceMemberAddImpl(getEnv(), user, data);
  });

export const teamspaceMemberRemove = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ teamspaceId: z.string().uuid(), userId: z.string().min(1) }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return teamspaceMemberRemoveImpl(getEnv(), user, data);
  });

// ---------- Phase 16 wrappers ----------

export const backlinks = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ pageId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return backlinksImpl(getEnv(), user, data.pageId);
  });

export const notificationsList = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z.object({ limit: z.number().int().positive().max(200).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return notificationsListImpl(getEnv(), user, data.limit);
  });

export const notificationsUnreadCount = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await requireUser();
  return unreadCountImpl(getEnv(), user);
});

export const notificationsMarkRead = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid().optional(), all: z.boolean().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return markReadImpl(getEnv(), user, data);
  });

export const reminderAdd = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z
      .object({
        pageId: z.string().uuid(),
        remindAt: z.string().min(1),
        body: z.string().max(2000).nullish(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return reminderAddImpl(getEnv(), user, data);
  });

export const remindersList = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ pageId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return remindersListImpl(getEnv(), user, data.pageId);
  });

export const reminderCancel = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return reminderCancelImpl(getEnv(), user, data.id);
  });

export const commentReact = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ commentId: z.string().uuid(), emoji: z.string().min(1).max(32) }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return reactImpl(getEnv(), user, data);
  });

export const commentReactions = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z.object({ commentIds: z.array(z.string().uuid()).max(500) }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return reactionsForCommentsImpl(getEnv(), user, data.commentIds);
  });

/* v8 ignore stop */
