import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Files } from 'files-sdk';
import { memory } from 'files-sdk/memory';
import { type TestDB, insertProject, insertUser, makeTestDb } from '../../src/testing/db';
import { attachments } from '@allenlabs/pm-core/db/schema';
import {
  deleteAttachmentImpl,
  listAttachmentsImpl,
  listProjectFilesImpl,
  streamAttachmentImpl,
  uploadAttachmentImpl,
} from '../../src/server/attachments';

let db: TestDB;
let projectId: number;
let authorId: number;
// In tests the storage is an in-memory files-sdk adapter; in prod the app wires
// the R2 binding adapter. The impls only see the provider-agnostic `Files`.
let files: Files;

beforeEach(async () => {
  db = await makeTestDb();
  const p = await insertProject(db);
  projectId = p.id;
  const u = await insertUser(db);
  authorId = u.id;
  files = new Files({ adapter: memory() });
});

function fileFromString(name: string, body: string, type = 'text/plain'): File {
  return new File([body], name, { type });
}

describe('attachment impls', () => {
  it('uploadAttachmentImpl stores in R2, writes metadata, computes digest', async () => {
    const file = fileFromString('hello.txt', 'hello world');
    const row = await uploadAttachmentImpl(db, files, {
      projectId,
      containerType: 'project',
      containerId: projectId,
      file,
      authorId,
      description: 'greeting',
    });
    expect(row.filename).toBe('hello.txt');
    expect(row.contentType).toBe('text/plain');
    expect(row.filesize).toBe(11);
    expect(row.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(row.r2Key).toContain('project/' + projectId + '/');
    expect(await files.exists(row.r2Key)).toBe(true);
  });

  it('defaults contentType when blank', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'bin', { type: '' });
    const row = await uploadAttachmentImpl(db, files, {
      projectId,
      containerType: 'project',
      containerId: projectId,
      file,
      authorId,
    });
    expect(row.contentType).toBe('application/octet-stream');
  });

  it('listAttachmentsImpl scopes by container', async () => {
    await uploadAttachmentImpl(db, files, {
      projectId, containerType: 'issue', containerId: 100,
      file: fileFromString('a.txt', 'a'), authorId,
    });
    await uploadAttachmentImpl(db, files, {
      projectId, containerType: 'project', containerId: projectId,
      file: fileFromString('b.txt', 'b'), authorId,
    });
    const issueOnly = await listAttachmentsImpl(db, 'issue', 100);
    expect(issueOnly.map((a) => a.filename)).toEqual(['a.txt']);
    const projectFiles = await listProjectFilesImpl(db, projectId);
    expect(projectFiles.map((a) => a.filename)).toEqual(['b.txt']);
  });

  it('streamAttachmentImpl serves content with sane headers', async () => {
    const file = fileFromString('readme.md', 'hi', 'text/markdown');
    const row = await uploadAttachmentImpl(db, files, {
      projectId, containerType: 'project', containerId: projectId, file, authorId,
    });
    const res = await streamAttachmentImpl(db, files, row.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/markdown');
    expect(res.headers.get('Content-Disposition')).toContain('readme.md');
  });

  it('streamAttachmentImpl returns 404 when metadata missing', async () => {
    const res = await streamAttachmentImpl(db, files, 99999);
    expect(res.status).toBe(404);
  });

  it('streamAttachmentImpl returns 404 when R2 object missing', async () => {
    const file = fileFromString('a.txt', 'a');
    const row = await uploadAttachmentImpl(db, files, {
      projectId, containerType: 'project', containerId: projectId, file, authorId,
    });
    await files.delete(row.r2Key);
    const res = await streamAttachmentImpl(db, files, row.id);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('Missing');
  });

  it('deleteAttachmentImpl removes from R2 and DB', async () => {
    const row = await uploadAttachmentImpl(db, files, {
      projectId, containerType: 'project', containerId: projectId,
      file: fileFromString('x.txt', 'x'), authorId,
    });
    const r = await deleteAttachmentImpl(db, files, row.id);
    expect(r).toEqual({ ok: true, deleted: true });
    expect(await db.query.attachments.findFirst({ where: eq(attachments.id, row.id) })).toBeUndefined();
    expect(await files.exists(row.r2Key)).toBe(false);
  });

  it('deleteAttachmentImpl is a no-op for missing ids', async () => {
    expect(await deleteAttachmentImpl(db, files, 999)).toEqual({ ok: true, deleted: false });
  });
});
