// Thin TanStack Start server-fn wrappers. The logic lives in
// @allenlabs/pm-core/server/attachments; this file binds the SSR runtime
// (getDb / getEnv / requirePermission) and the concrete files-sdk storage
// adapter — the native Cloudflare R2 binding (`env.FILES`), so reads/writes stay
// intra-Worker (no egress). Exercised by the wrangler integration tests.
/* v8 ignore start */
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { Files } from 'files-sdk';
import { r2 } from 'files-sdk/r2';
import type { R2Bucket } from '@cloudflare/workers-types';
import {
  type UploadAttachmentInput,
  deleteAttachmentImpl,
  listAttachmentsImpl,
  listProjectFilesImpl,
  streamAttachmentImpl,
  uploadAttachmentImpl,
} from '@allenlabs/pm-core/server/attachments';
import { getDb, getEnv, requirePermission } from './auth-runtime.server';

/** The files-sdk client backed by the Worker's R2 binding. */
function filesClient() {
  // getEnv().FILES is the ambient-global R2Bucket; files-sdk/r2 wants the
  // module-imported one. Same runtime object, nominally distinct types.
  return new Files({ adapter: r2({ binding: getEnv().FILES as unknown as R2Bucket }) });
}

export const listAttachments = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) =>
    z
      .object({
        projectId: z.number(),
        containerType: z.enum(['issue', 'wiki_page', 'project', 'journal']),
        containerId: z.number(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'view_files');
    return listAttachmentsImpl(getDb(), data.containerType, data.containerId);
  });

export const listProjectFiles = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'view_files');
    return listProjectFilesImpl(getDb(), data.projectId);
  });

export async function uploadAttachment(opts: UploadAttachmentInput) {
  return uploadAttachmentImpl(getDb(), filesClient(), opts);
}

export async function streamAttachment(id: number): Promise<Response> {
  return streamAttachmentImpl(getDb(), filesClient(), id);
}

export const deleteAttachment = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_files');
    return deleteAttachmentImpl(getDb(), filesClient(), data.id);
  });

/* v8 ignore stop */
