import { and, desc, eq } from 'drizzle-orm';
import type { Files } from 'files-sdk';
import { type DB } from '../db/client';
import { attachments } from '../db/schema';

// Object storage goes through files-sdk's provider-agnostic `Files` client
// rather than a raw R2 binding, so a consumer can back attachments with R2
// (the allenlabs default, via the binding adapter), S3, or any other files-sdk
// adapter without touching these impls. The app wires the concrete adapter and
// passes the client in.

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
  files: Files,
  input: UploadAttachmentInput,
): Promise<typeof attachments.$inferSelect> {
  const arr = new Uint8Array(await input.file.arrayBuffer());
  const digestBuf = await crypto.subtle.digest('SHA-256', arr);
  const digest = Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const contentType = input.file.type || 'application/octet-stream';
  const storageKey = `${input.containerType}/${input.projectId}/${digest}_${input.file.name}`;
  await files.upload(storageKey, arr, { contentType });
  const [row] = await db
    .insert(attachments)
    .values({
      containerType: input.containerType,
      containerId: input.containerId,
      filename: input.file.name,
      contentType,
      filesize: input.file.size,
      digest,
      r2Key: storageKey,
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
  files: Files,
  id: number,
): Promise<{ ok: true; deleted: boolean }> {
  const att = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
  if (!att) return { ok: true, deleted: false };
  await files.delete(att.r2Key);
  await db.delete(attachments).where(eq(attachments.id, id));
  return { ok: true, deleted: true };
}

export async function streamAttachmentImpl(
  db: DB,
  files: Files,
  id: number,
): Promise<Response> {
  const att = await db.query.attachments.findFirst({ where: eq(attachments.id, id) });
  if (!att) return new Response('Not found', { status: 404 });
  if (!(await files.exists(att.r2Key))) return new Response('Missing', { status: 404 });
  const stored = await files.download(att.r2Key);
  return new Response(stored.stream(), {
    headers: {
      'Content-Type': att.contentType,
      'Content-Length': String(att.filesize),
      'Content-Disposition': `inline; filename="${encodeURIComponent(att.filename)}"`,
      'Cache-Control': 'private, max-age=300',
    },
  });
}
