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
  | 'phone';

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
  groupBy?: string;
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

export interface DbRow {
  id: string;
  title: string;
  props: Record<string, JsonValue>;
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
  input: { databaseId: string; type: 'table' | 'board'; name?: string; config?: Record<string, unknown> },
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
]);

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
        type: z.enum(['table', 'board']),
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

/* v8 ignore stop */
