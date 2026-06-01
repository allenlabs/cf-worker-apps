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

/* v8 ignore stop */
