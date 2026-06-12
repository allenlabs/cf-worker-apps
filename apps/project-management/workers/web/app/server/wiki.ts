// Thin TanStack Start server-fn wrappers. The logic lives in
// @allenlabs/pm-core/server/wiki; this file only binds the SSR runtime
// (getDb / requirePermission) — exercised by the wrangler integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import {
  deleteWikiPageImpl,
  getWikiPageImpl,
  listWikiPagesImpl,
  saveWikiPageSchema,
  saveWikiPageImpl,
} from '@allenlabs/pm-core/server/wiki';
import { getDb, requirePermission } from './auth-runtime.server';

export const listWikiPages = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'view_wiki_pages');
    return listWikiPagesImpl(getDb(), data.projectId);
  });

export const getWikiPage = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number(), slug: z.string() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'view_wiki_pages');
    return getWikiPageImpl(getDb(), data.projectId, data.slug);
  });

export const saveWikiPage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => saveWikiPageSchema.parse(d))
  .handler(async ({ data }) => {
    const { user } = await requirePermission(data.projectId, 'edit_wiki_pages');
    return saveWikiPageImpl(getDb(), user, data);
  });

export const deleteWikiPage = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_wiki');
    return deleteWikiPageImpl(getDb(), data.id);
  });

/* v8 ignore stop */
