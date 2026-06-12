import { createServerFn } from '@tanstack/react-start';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '@allenlabs/pm-core/db/client';
import { attachments } from '@allenlabs/pm-core/db/schema';
import { getDb, getEnv, requirePermission } from './auth-runtime.server';

export type ContainerType = 'issue' | 'wiki_page' | 'project' | 'journal';

export async function listAttachmentsImpl(
  db: DB,
  containerType: ContainerType,
  containerId: number,
) {
  return db
    .select()
    .from(attachments)
    .where(
      and(
        eq(attachments.containerType, containerType),
        eq(attachments.containerId, containerId),
      ),
    )
    .orderBy(desc(attachments.createdAt));
}

export async function listProjectFilesImpl(db: DB, projectId: number) {
  return listAttachmentsImpl(db, 'project', projectId);
}

export interface UploadAttachmentInput {
  projectId: number;
  containerType: ContainerType;
  containerId: number;
  file: File;
  authorId: number;
  description?: string;
}

export async function uploadAttachmentImpl(
  db: DB,
  r2: R2Bucket,
  input: UploadAttachmentInput,
): Promise<typeof attachments.$inferSelect> {
  const arr = new Uint8Array(await input.file.arrayBuffer());
  const digestBuf = await crypto.subtle.digest('SHA-256', arr);
  const digest = Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const r2Key = `${input.containerType}/${input.projectId}/${digest}_${input.file.name}`;
  await r2.put(r2Key, arr, {
    httpMetadata: { contentType: input.file.type || 'application/octet-stream' },
  });
  const [row] = await db
    .insert(attachments)
    .values({
      containerType: input.containerType,
      containerId: input.containerId,
      filename: input.file.name,
      contentType: input.file.type || 'application/octet-stream',
      filesize: input.file.size,
      digest,
      r2Key,
      authorId: input.authorId,
      description: input.description ?? '',
    })
    .returning();
  /* v8 ignore next */
  if (!row) throw new Error('attachment insert returned no row');
  return row;
}

export async function deleteAttachmentImpl(
  db: DB,
  r2: R2Bucket,
  id: number,
): Promise<{ ok: true; deleted: boolean }> {
  const att = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
  if (!att) return { ok: true, deleted: false };
  await r2.delete(att.r2Key);
  await db.delete(attachments).where(eq(attachments.id, id));
  return { ok: true, deleted: true };
}

export async function streamAttachmentImpl(
  db: DB,
  r2: R2Bucket,
  id: number,
): Promise<Response> {
  const att = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
  if (!att) return new Response('Not found', { status: 404 });
  const obj = await r2.get(att.r2Key);
  if (!obj) return new Response('Missing', { status: 404 });
  return new Response(obj.body as any, {
    headers: {
      'Content-Type': att.contentType,
      'Content-Length': String(att.filesize),
      'Content-Disposition': `inline; filename="${encodeURIComponent(att.filename)}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
/* v8 ignore start */

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
  return uploadAttachmentImpl(getDb(), getEnv().FILES, opts);
}

export async function streamAttachment(id: number): Promise<Response> {
  return streamAttachmentImpl(getDb(), getEnv().FILES, id);
}

export const deleteAttachment = createServerFn({ method: 'POST' })
  .inputValidator((d: unknown) => z.object({ id: z.number(), projectId: z.number() }).parse(d))
  .handler(async ({ data }) => {
    await requirePermission(data.projectId, 'manage_files');
    return deleteAttachmentImpl(getDb(), getEnv().FILES, data.id);
  });

/* v8 ignore stop */
