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
}

export interface PageFull {
  id: string;
  workspaceId: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  snapshotHtml: string;
  kind: string; // 'page' | 'database'
  databaseId: string | null;
  public: boolean; // Phase 4 — public share toggle state
  favorited: boolean; // Phase 4 — starred by the requesting user
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
  authorName: string;
  body: string;
  resolved: boolean;
  createdAt: string;
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

export interface DbViewConfig {
  filters?: { propId: string; value?: JsonValue }[];
  sorts?: { propId: string; dir?: 'asc' | 'desc' }[];
  groupBy?: string; // board: select/status prop to column by
  datePropId?: string; // calendar/timeline: date prop to place rows by
  cardPropId?: string; // gallery: prop shown as the card preview
  visible?: string[];
}

export interface DbView {
  id: string;
  databaseId: string;
  name: string;
  type: string; // 'table' | 'board'
  config: DbViewConfig;
  position: number;
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
  input: { workspaceId: string; parentId?: string | null; title?: string; icon?: string | null },
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
  input: { id: string; title?: string; icon?: string | null; snapshotHtml?: string },
  deps?: ApiClientDeps,
): Promise<{ ok: boolean }> {
  return apiPostImpl<{ ok: boolean }>(env, '/v1/pages/update', userBody(user, input), deps);
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
  input: { databaseId: string; type: ViewType; name?: string; config?: Record<string, unknown> },
  deps?: ApiClientDeps,
): Promise<DbView> {
  return apiPostImpl<DbView>(env, '/v1/db/view/add', userBody(user, input), deps);
}

export function viewUpdateImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; name?: string; config?: Record<string, unknown> },
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
  input: { databaseId: string; viewId?: string },
  deps?: ApiClientDeps,
): Promise<DbRow[]> {
  return apiPostImpl<DbRow[]>(env, '/v1/db/rows', userBody(user, input), deps);
}

export function rowAddImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { databaseId: string; title?: string },
  deps?: ApiClientDeps,
): Promise<DbRow> {
  return apiPostImpl<DbRow>(env, '/v1/db/row/add', userBody(user, input), deps);
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
  pageId: string,
  deps?: ApiClientDeps,
): Promise<CommentItem[]> {
  return apiPostImpl<CommentItem[]>(env, '/v1/comments/list', userBody(user, { pageId }), deps);
}

export function commentAddImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { pageId: string; body: string },
  deps?: ApiClientDeps,
): Promise<CommentItem> {
  return apiPostImpl<CommentItem>(env, '/v1/comments/add', userBody(user, input), deps);
}

export function commentResolveImpl(
  env: ApiClientEnv,
  user: CurrentUser,
  input: { id: string; resolved: boolean },
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
        snapshotHtml: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return updatePageImpl(getEnv(), user, {
      id: data.id,
      title: data.title,
      icon: data.icon === undefined ? undefined : data.icon ?? null,
      snapshotHtml: data.snapshotHtml,
    });
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
    z.object({ databaseId: z.string().uuid(), viewId: z.string().uuid().optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return dbRowsImpl(getEnv(), user, data);
  });

export const rowAdd = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ databaseId: z.string().uuid(), title: z.string().max(255).optional() }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return rowAddImpl(getEnv(), user, data);
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
  .inputValidator((d: unknown) => z.object({ pageId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const user = await requireUser();
    return commentsListImpl(getEnv(), user, data.pageId);
  });

export const commentAdd = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ pageId: z.string().uuid(), body: z.string().min(1).max(10000) }).parse(d),
  )
  .handler(async ({ data }) => {
    const user = await requireUser();
    return commentAddImpl(getEnv(), user, data);
  });

export const commentResolve = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) =>
    z.object({ id: z.string().uuid(), resolved: z.boolean() }).parse(d),
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

/* v8 ignore stop */
