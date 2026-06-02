// POST-only /v1 endpoints. The HMAC middleware has already verified the
// signature, parsed the JSON body into `c.var.body`, populated `c.var.user`
// (from the trusted JWT claims), and opened a per-request `c.var.db`.
//
// Every endpoint is POST-with-a-body so the HMAC scheme stays uniform.
//
// Phase 1 (workspaces + page tree) lives under /v1/workspaces/* and /v1/pages/*.
// The legacy flat /v1/docs/* endpoints remain (DEPRECATED) for any old client;
// the web no longer calls them. New code reads/writes editor.pages.

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  createDocImpl,
  deleteDocImpl,
  getDocImpl,
  listDocsImpl,
  searchUsersImpl,
  updateDocImpl,
} from './docs';
import {
  archivePageImpl,
  canAccessPageImpl,
  canEditPageImpl,
  createPageImpl,
  duplicatePageImpl,
  getPageImpl,
  isMemberImpl,
  hasAnyMembershipImpl,
  isPageOwnerImpl,
  listOrProvisionWorkspacesImpl,
  movePageImpl,
  pageRoleImpl,
  pageTreeImpl,
  setLockedImpl,
  setRestrictedImpl,
  updatePageImpl,
} from './pages';
import {
  pageSharesImpl,
  shareePageImpl,
  sharedWithMeImpl,
  teamspaceCreateImpl,
  teamspaceDeleteImpl,
  teamspaceMemberAddImpl,
  teamspaceMemberRemoveImpl,
  teamspaceMembersImpl,
  teamspaceRenameImpl,
  teamspaceWorkspaceImpl,
  teamspacesListImpl,
  unsharePageImpl,
} from './sharing';
import {
  addPropertyImpl,
  addRowImpl,
  addViewImpl,
  createDatabaseImpl,
  dbRowsImpl,
  dbSchemaImpl,
  deletePropertyImpl,
  deleteRowImpl,
  deleteViewImpl,
  listDatabasesImpl,
  propertyDatabaseImpl,
  relatedRowsImpl,
  rowDatabaseImpl,
  updatePropertyImpl,
  updateRowImpl,
  updateViewImpl,
  viewDatabaseImpl,
} from './db';
import { prepareUpload, publicUrlFor } from './files';
import {
  commentAddImpl,
  commentAuthorImpl,
  commentDeleteImpl,
  commentResolveImpl,
  commentResolveThreadImpl,
  commentThreadsImpl,
  commentsListImpl,
  favListImpl,
  favToggleImpl,
  isFavoritedImpl,
  purgePageImpl,
  restorePageImpl,
  searchImpl,
  setPublicImpl,
  trashListImpl,
} from './collab';
import {
  restoreVersionImpl,
  versionGetImpl,
  versionPageImpl,
  versionsListImpl,
} from './versions';
import { mintCollabToken } from '../lib/hmac';
import type { AppBindings } from '../context';

export const v1Router = new Hono<AppBindings>();

const idSchema = z.object({ id: z.string().uuid() });

// ---------- workspaces ----------

v1Router.post('/workspaces/list', async (c) => {
  const user = c.get('user');
  const workspaces = await listOrProvisionWorkspacesImpl(c.get('db'), user.userId);
  return c.json(workspaces, 200);
});

// ---------- pages ----------

const treeSchema = z.object({ workspaceId: z.string().uuid() });
v1Router.post('/pages/tree', async (c) => {
  const user = c.get('user');
  const parsed = treeSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const member = await isMemberImpl(c.get('db'), user.userId, parsed.data.workspaceId);
  if (!member) return c.json({ error: 'not found' }, 404);
  const pages = await pageTreeImpl(c.get('db'), parsed.data.workspaceId);
  return c.json(pages, 200);
});

const createPageSchema = z.object({
  workspaceId: z.string().uuid(),
  parentId: z.string().uuid().nullish(),
  title: z.string().max(255).optional(),
  icon: z.string().max(32).nullish(),
  teamspaceId: z.string().uuid().nullish(),
});
v1Router.post('/pages/create', async (c) => {
  const user = c.get('user');
  const parsed = createPageSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const member = await isMemberImpl(c.get('db'), user.userId, parsed.data.workspaceId);
  if (!member) return c.json({ error: 'not found' }, 404);
  // If a parent is given, it must live in the same workspace.
  if (parsed.data.parentId) {
    const parent = await getPageImpl(c.get('db'), parsed.data.parentId);
    if (!parent || parent.workspaceId !== parsed.data.workspaceId) {
      return c.json({ error: 'not found' }, 404);
    }
  }
  // If a teamspace is given, it must live in the same workspace.
  if (parsed.data.teamspaceId) {
    const tws = await teamspaceWorkspaceImpl(c.get('db'), parsed.data.teamspaceId);
    if (tws !== parsed.data.workspaceId) return c.json({ error: 'not found' }, 404);
  }
  const created = await createPageImpl(c.get('db'), user.userId, {
    workspaceId: parsed.data.workspaceId,
    parentId: parsed.data.parentId ?? null,
    title: parsed.data.title,
    icon: parsed.data.icon ?? null,
    teamspaceId: parsed.data.teamspaceId ?? null,
  });
  return c.json(created, 200);
});

// Phase 14: deep-copy a page + its descendant subtree (new uuids, parent
// remapped). Requires read access to the source; the copy is owned by the
// requester. Returns the new root id for a full-page nav.
v1Router.post('/pages/duplicate', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  if (!(await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id))) {
    return c.json({ error: 'not found' }, 404);
  }
  const created = await duplicatePageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!created) return c.json({ error: 'not found' }, 404);
  return c.json(created, 200);
});

v1Router.post('/pages/get', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const page = await getPageImpl(c.get('db'), parsed.data.id);
  if (!page) return c.json({ error: 'not found' }, 404);
  // Phase 9: members get 'owner'; otherwise a direct/ancestor share role gates
  // access. A viewer-only share still resolves the page (read-only on the web).
  const role = await pageRoleImpl(c.get('db'), user.userId, page.id);
  if (!role) return c.json({ error: 'not found' }, 404);
  const favorited = await isFavoritedImpl(c.get('db'), user.userId, page.id);
  return c.json({ ...page, favorited, role }, 200);
});

const updatePageSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(255).optional(),
  icon: z.string().max(32).nullish(),
  cover: z.string().max(2048).nullish(),
  snapshotHtml: z.string().optional(),
  fullWidth: z.boolean().optional(),
});
v1Router.post('/pages/update', async (c) => {
  const user = c.get('user');
  const parsed = updatePageSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // Content writes require edit access — a 'view'-shared user is read-only.
  if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const ok = await updatePageImpl(c.get('db'), parsed.data.id, {
    title: parsed.data.title,
    icon: parsed.data.icon === undefined ? undefined : parsed.data.icon ?? null,
    cover: parsed.data.cover === undefined ? undefined : parsed.data.cover ?? null,
    snapshotHtml: parsed.data.snapshotHtml,
    fullWidth: parsed.data.fullWidth,
    author: { id: user.userId, name: user.userName },
  });
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

const movePageSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullish(),
  position: z.number().optional(),
  teamspaceId: z.string().uuid().nullish(),
});
v1Router.post('/pages/move', async (c) => {
  const user = c.get('user');
  const parsed = movePageSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // Moving a page is a write — require edit access on the page being moved.
  if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  // A new parent (when given) must be in the same workspace and accessible.
  if (parsed.data.parentId) {
    const can2 = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.parentId);
    if (!can2) return c.json({ error: 'not found' }, 404);
  }
  // A target teamspace (when given) must belong to the page's workspace.
  if (parsed.data.teamspaceId) {
    const page = await getPageImpl(c.get('db'), parsed.data.id);
    const tws = await teamspaceWorkspaceImpl(c.get('db'), parsed.data.teamspaceId);
    if (!page || tws !== page.workspaceId) return c.json({ error: 'not found' }, 404);
  }
  let ok: boolean;
  try {
    ok = await movePageImpl(c.get('db'), {
      id: parsed.data.id,
      parentId: parsed.data.parentId === undefined ? undefined : parsed.data.parentId ?? null,
      position: parsed.data.position,
      teamspaceId: parsed.data.teamspaceId === undefined ? undefined : parsed.data.teamspaceId ?? null,
    });
  } catch {
    return c.json({ error: 'cycle' }, 400);
  }
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

v1Router.post('/pages/archive', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // Archiving (delete) is a write — require edit access.
  if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const ok = await archivePageImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

// ---------- file upload (image → R2) ----------

const uploadSchema = z.object({
  filename: z.string().max(255).optional(),
  contentType: z.string().min(1).max(128),
  dataBase64: z.string().min(1),
});
v1Router.post('/files/upload', async (c) => {
  // userId is already verified by the HMAC middleware; presence is enough here.
  const parsed = uploadSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const prepared = prepareUpload(parsed.data, () => crypto.randomUUID());
  if ('ok' in prepared && prepared.ok === false) {
    return c.json({ error: prepared.error }, prepared.status);
  }
  const { bytes, key, contentType } = prepared as {
    bytes: Uint8Array;
    key: string;
    contentType: string;
  };
  await c.env.FILES.put(key, bytes, { httpMetadata: { contentType } });
  return c.json({ url: publicUrlFor(key), key }, 200);
});

// ---------- mention search (unchanged) ----------

const searchSchema = z.object({ q: z.string().default('') });
v1Router.post('/users/search', async (c) => {
  const parsed = searchSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const results = await searchUsersImpl(c.get('db'), parsed.data.q);
  return c.json(results, 200);
});

// ---------- collab token (membership-gated) ----------
//
// Two room shapes:
//   - a page id (UUID)        → gated on access to THAT page (canAccessPageImpl).
//   - a synced-block room      → `sync-<uuid>` (Phase 12). The room is
//     self-describing: knowing the syncId means you were on a page that embeds
//     the block, so we only require the requester to be a provisioned suite user
//     (≥1 workspace membership). v1 synced-block content is NOT separately
//     ACL'd beyond needing the syncId — tighter per-sync ACL is a follow-up.

/** Matches a synced-block room: literal `sync-` + a UUID. */
const SYNC_ROOM_RE = /^sync-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const collabSchema = z.object({
  docId: z.string().refine((v) => z.string().uuid().safeParse(v).success || SYNC_ROOM_RE.test(v), {
    message: 'docId must be a page UUID or a sync-<uuid> room',
  }),
});
v1Router.post('/collab-token', async (c) => {
  const user = c.get('user');
  const parsed = collabSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const docId = parsed.data.docId;
  const isSyncRoom = SYNC_ROOM_RE.test(docId);
  if (isSyncRoom) {
    // Synced block: any provisioned suite user may mint for an arbitrary room.
    const member = await hasAnyMembershipImpl(c.get('db'), user.userId);
    if (!member) return c.json({ error: 'not found' }, 404);
  } else {
    // Page room: the page's workspace must include this user. (docId is the page id.)
    const can = await canAccessPageImpl(c.get('db'), user.userId, docId);
    if (!can) return c.json({ error: 'not found' }, 404);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    room: docId,
    exp: nowSec + 3600,
    uid: user.userId,
    name: user.userName,
  };
  const token = await mintCollabToken(c.env.COLLAB_HMAC_SECRET, payload);
  return c.json({ token, url: c.env.COLLAB_URL, docId }, 200);
});

// ---------- databases (Phase 3) ----------
//
// A database is a page (kind='database'); rows are pages with database_id set.
// Access is gated by membership in the database page's workspace (or the row's,
// which is the same workspace). property/view ids resolve to their database
// first, then to the workspace via canAccessPageImpl.

const propertyType = z.enum([
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

const dbCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  parentId: z.string().uuid().nullish(),
  title: z.string().max(255).optional(),
});
v1Router.post('/db/create', async (c) => {
  const user = c.get('user');
  const parsed = dbCreateSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const member = await isMemberImpl(c.get('db'), user.userId, parsed.data.workspaceId);
  if (!member) return c.json({ error: 'not found' }, 404);
  if (parsed.data.parentId) {
    const parent = await getPageImpl(c.get('db'), parsed.data.parentId);
    if (!parent || parent.workspaceId !== parsed.data.workspaceId) {
      return c.json({ error: 'not found' }, 404);
    }
  }
  const created = await createDatabaseImpl(c.get('db'), user.userId, {
    workspaceId: parsed.data.workspaceId,
    parentId: parsed.data.parentId ?? null,
    title: parsed.data.title,
  });
  return c.json(created, 200);
});

const dbIdSchema = z.object({ databaseId: z.string().uuid() });
v1Router.post('/db/schema', async (c) => {
  const user = c.get('user');
  const parsed = dbIdSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.databaseId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const schema = await dbSchemaImpl(c.get('db'), parsed.data.databaseId);
  if (!schema) return c.json({ error: 'not found' }, 404);
  return c.json(schema, 200);
});

// Phase 6: list the workspace's databases (for the relation target picker).
const dbListSchema = z.object({ workspaceId: z.string().uuid() });
v1Router.post('/db/list', async (c) => {
  const user = c.get('user');
  const parsed = dbListSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const member = await isMemberImpl(c.get('db'), user.userId, parsed.data.workspaceId);
  if (!member) return c.json({ error: 'not found' }, 404);
  const databases = await listDatabasesImpl(c.get('db'), parsed.data.workspaceId);
  return c.json(databases, 200);
});

// Phase 6: search a target database's rows for the relation cell picker.
const relatedRowsSchema = z.object({
  databaseId: z.string().uuid(),
  q: z.string().max(255).optional(),
});
v1Router.post('/db/related-rows', async (c) => {
  const user = c.get('user');
  const parsed = relatedRowsSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.databaseId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const rows = await relatedRowsImpl(c.get('db'), parsed.data.databaseId, parsed.data.q);
  return c.json(rows, 200);
});

const propAddSchema = z.object({
  databaseId: z.string().uuid(),
  name: z.string().min(1).max(120),
  type: propertyType,
  config: z.record(z.string(), z.unknown()).optional(),
});
v1Router.post('/db/property/add', async (c) => {
  const user = c.get('user');
  const parsed = propAddSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.databaseId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const prop = await addPropertyImpl(c.get('db'), {
    databaseId: parsed.data.databaseId,
    name: parsed.data.name,
    type: parsed.data.type,
    config: parsed.data.config,
  });
  return c.json(prop, 200);
});

const propUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  type: propertyType.optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
v1Router.post('/db/property/update', async (c) => {
  const user = c.get('user');
  const parsed = propUpdateSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const dbId = await propertyDatabaseImpl(c.get('db'), parsed.data.id);
  if (!dbId) return c.json({ error: 'not found' }, 404);
  if (!(await canEditPageImpl(c.get('db'), user.userId, dbId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const ok = await updatePropertyImpl(c.get('db'), parsed.data.id, {
    name: parsed.data.name,
    type: parsed.data.type,
    config: parsed.data.config,
  });
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

v1Router.post('/db/property/delete', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const dbId = await propertyDatabaseImpl(c.get('db'), parsed.data.id);
  if (!dbId) return c.json({ error: 'not found' }, 404);
  if (!(await canEditPageImpl(c.get('db'), user.userId, dbId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const ok = await deletePropertyImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

const viewType = z.enum(['table', 'board', 'list', 'gallery', 'calendar', 'timeline']);

const viewAddSchema = z.object({
  databaseId: z.string().uuid(),
  type: viewType,
  name: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
v1Router.post('/db/view/add', async (c) => {
  const user = c.get('user');
  const parsed = viewAddSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.databaseId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const view = await addViewImpl(c.get('db'), {
    databaseId: parsed.data.databaseId,
    type: parsed.data.type,
    name: parsed.data.name,
    config: parsed.data.config,
  });
  return c.json(view, 200);
});

const viewUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
v1Router.post('/db/view/update', async (c) => {
  const user = c.get('user');
  const parsed = viewUpdateSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const dbId = await viewDatabaseImpl(c.get('db'), parsed.data.id);
  if (!dbId) return c.json({ error: 'not found' }, 404);
  if (!(await canEditPageImpl(c.get('db'), user.userId, dbId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const ok = await updateViewImpl(c.get('db'), parsed.data.id, {
    name: parsed.data.name,
    config: parsed.data.config,
  });
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

v1Router.post('/db/view/delete', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const dbId = await viewDatabaseImpl(c.get('db'), parsed.data.id);
  if (!dbId) return c.json({ error: 'not found' }, 404);
  if (!(await canEditPageImpl(c.get('db'), user.userId, dbId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const ok = await deleteViewImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

const dbRowsSchema = z.object({
  databaseId: z.string().uuid(),
  viewId: z.string().uuid().optional(),
});
v1Router.post('/db/rows', async (c) => {
  const user = c.get('user');
  const parsed = dbRowsSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.databaseId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const rows = await dbRowsImpl(c.get('db'), parsed.data.databaseId, parsed.data.viewId);
  return c.json(rows, 200);
});

const rowAddSchema = z.object({
  databaseId: z.string().uuid(),
  title: z.string().max(255).optional(),
});
v1Router.post('/db/row/add', async (c) => {
  const user = c.get('user');
  const parsed = rowAddSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.databaseId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const row = await addRowImpl(c.get('db'), user.userId, {
    databaseId: parsed.data.databaseId,
    title: parsed.data.title,
  });
  return c.json(row, 200);
});

const rowUpdateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(255).optional(),
  props: z.record(z.string(), z.unknown()).optional(),
});
v1Router.post('/db/row/update', async (c) => {
  const user = c.get('user');
  const parsed = rowUpdateSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // Rows are pages; canEditPageImpl resolves the row's workspace directly.
  if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if ((await rowDatabaseImpl(c.get('db'), parsed.data.id)) === null) {
    return c.json({ error: 'not found' }, 404);
  }
  const ok = await updateRowImpl(c.get('db'), parsed.data.id, {
    title: parsed.data.title,
    props: parsed.data.props,
  });
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

v1Router.post('/db/row/delete', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  if ((await rowDatabaseImpl(c.get('db'), parsed.data.id)) === null) {
    return c.json({ error: 'not found' }, 404);
  }
  const ok = await deleteRowImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

// ---------- favorites (Phase 4) ----------

v1Router.post('/fav/list', async (c) => {
  const user = c.get('user');
  const favs = await favListImpl(c.get('db'), user.userId);
  return c.json(favs, 200);
});

const favToggleSchema = z.object({ pageId: z.string().uuid() });
v1Router.post('/fav/toggle', async (c) => {
  const user = c.get('user');
  const parsed = favToggleSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // Membership-gated: the page's workspace must include the user.
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const result = await favToggleImpl(c.get('db'), user.userId, parsed.data.pageId);
  return c.json(result, 200);
});

// ---------- trash (Phase 4) ----------

const trashSchema = z.object({ workspaceId: z.string().uuid() });
v1Router.post('/pages/trash', async (c) => {
  const user = c.get('user');
  const parsed = trashSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const member = await isMemberImpl(c.get('db'), user.userId, parsed.data.workspaceId);
  if (!member) return c.json({ error: 'not found' }, 404);
  const pages = await trashListImpl(c.get('db'), parsed.data.workspaceId);
  return c.json(pages, 200);
});

v1Router.post('/pages/restore', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // canAccessPageImpl resolves the page's workspace even when archived.
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!can) return c.json({ error: 'not found' }, 404);
  const ok = await restorePageImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

v1Router.post('/pages/purge', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!can) return c.json({ error: 'not found' }, 404);
  const ok = await purgePageImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

// ---------- search (Phase 4) ----------

const qSchema = z.object({ q: z.string().default('') });
v1Router.post('/search', async (c) => {
  const user = c.get('user');
  const parsed = qSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const results = await searchImpl(c.get('db'), user.userId, parsed.data.q);
  return c.json(results, 200);
});

// ---------- public sharing (Phase 4) ----------

const setPublicSchema = z.object({ id: z.string().uuid(), public: z.boolean() });
v1Router.post('/pages/setPublic', async (c) => {
  const user = c.get('user');
  const parsed = setPublicSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!can) return c.json({ error: 'not found' }, 404);
  const result = await setPublicImpl(c.get('db'), parsed.data.id, parsed.data.public);
  if (!result) return c.json({ error: 'not found' }, 404);
  return c.json(result, 200);
});

// ---------- per-page restriction (Phase 10) ----------
//
// Toggling restriction is OWNER-only: it changes who can see the page, so a
// merely-shared editor shouldn't flip it.

const setRestrictedSchema = z.object({ id: z.string().uuid(), restricted: z.boolean() });
v1Router.post('/pages/set-restricted', async (c) => {
  const user = c.get('user');
  const parsed = setRestrictedSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  if (!(await isPageOwnerImpl(c.get('db'), user.userId, parsed.data.id))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  const result = await setRestrictedImpl(c.get('db'), parsed.data.id, parsed.data.restricted);
  if (!result) return c.json({ error: 'not found' }, 404);
  return c.json(result, 200);
});

// ---------- per-page lock (Phase 14) ----------
//
// Locking makes a page read-only for EVERYONE; canEditPageImpl refuses writes
// while locked. The toggle itself must therefore NOT go through canEditPageImpl
// (it would refuse to unlock) — we gate on the role directly (owner|edit) so an
// editor can always lock + unlock.

const setLockedSchema = z.object({ id: z.string().uuid(), locked: z.boolean() });
v1Router.post('/pages/set-locked', async (c) => {
  const user = c.get('user');
  const parsed = setLockedSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const role = await pageRoleImpl(c.get('db'), user.userId, parsed.data.id);
  if (role !== 'owner' && role !== 'edit') {
    return c.json({ error: 'forbidden' }, 403);
  }
  const result = await setLockedImpl(c.get('db'), parsed.data.id, parsed.data.locked);
  if (!result) return c.json({ error: 'not found' }, 404);
  return c.json(result, 200);
});

// ---------- per-user sharing (Phase 9) ----------
//
// A page can be shared directly to a single suite user (view|edit). The share
// PROPAGATES to descendants (pageRoleImpl walks ancestors). All write routes
// are gated on access to the page being shared.

const shareSchema = z.object({
  pageId: z.string().uuid(),
  query: z.string().min(1).max(255),
  role: z.enum(['view', 'edit']).default('view'),
});
v1Router.post('/pages/share', async (c) => {
  const user = c.get('user');
  const parsed = shareSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const shared = await shareePageImpl(c.get('db'), {
    pageId: parsed.data.pageId,
    query: parsed.data.query,
    role: parsed.data.role,
  });
  if (!shared) return c.json({ error: 'no user' }, 404);
  return c.json(shared, 200);
});

const unshareSchema = z.object({ pageId: z.string().uuid(), userId: z.string().min(1) });
v1Router.post('/pages/unshare', async (c) => {
  const user = c.get('user');
  const parsed = unshareSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const ok = await unsharePageImpl(c.get('db'), parsed.data.pageId, parsed.data.userId);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

const sharesSchema = z.object({ pageId: z.string().uuid() });
v1Router.post('/pages/shares', async (c) => {
  const user = c.get('user');
  const parsed = sharesSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const shares = await pageSharesImpl(c.get('db'), parsed.data.pageId);
  return c.json(shares, 200);
});

v1Router.post('/pages/shared-with-me', async (c) => {
  const user = c.get('user');
  const items = await sharedWithMeImpl(c.get('db'), user.userId);
  return c.json(items, 200);
});

// ---------- teamspaces (Phase 9) ----------
//
// A teamspace is a named group of root pages WITHIN a workspace. v1 access ==
// workspace membership (no separate per-teamspace ACL yet — follow-up).

const tsListSchema = z.object({ workspaceId: z.string().uuid() });
v1Router.post('/teamspaces/list', async (c) => {
  const user = c.get('user');
  const parsed = tsListSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const member = await isMemberImpl(c.get('db'), user.userId, parsed.data.workspaceId);
  if (!member) return c.json({ error: 'not found' }, 404);
  const teamspaces = await teamspacesListImpl(c.get('db'), parsed.data.workspaceId);
  return c.json(teamspaces, 200);
});

const tsCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().max(120).optional(),
});
v1Router.post('/teamspaces/create', async (c) => {
  const user = c.get('user');
  const parsed = tsCreateSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const member = await isMemberImpl(c.get('db'), user.userId, parsed.data.workspaceId);
  if (!member) return c.json({ error: 'not found' }, 404);
  const ts = await teamspaceCreateImpl(c.get('db'), parsed.data.workspaceId, parsed.data.name ?? 'Teamspace');
  return c.json(ts, 200);
});

const tsRenameSchema = z.object({ id: z.string().uuid(), name: z.string().min(1).max(120) });
v1Router.post('/teamspaces/rename', async (c) => {
  const user = c.get('user');
  const parsed = tsRenameSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const wsId = await teamspaceWorkspaceImpl(c.get('db'), parsed.data.id);
  if (!wsId) return c.json({ error: 'not found' }, 404);
  const member = await isMemberImpl(c.get('db'), user.userId, wsId);
  if (!member) return c.json({ error: 'not found' }, 404);
  const ok = await teamspaceRenameImpl(c.get('db'), parsed.data.id, parsed.data.name);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

v1Router.post('/teamspaces/delete', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const wsId = await teamspaceWorkspaceImpl(c.get('db'), parsed.data.id);
  if (!wsId) return c.json({ error: 'not found' }, 404);
  const member = await isMemberImpl(c.get('db'), user.userId, wsId);
  if (!member) return c.json({ error: 'not found' }, 404);
  const ok = await teamspaceDeleteImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

// ---------- teamspace membership (Phase 10) ----------
//
// Opt-in per-teamspace ACL. v1: any workspace member of the teamspace's
// workspace may view + manage members (matches teamspace CRUD's gate).

/** Shared gate: the teamspace exists and the user is a member of its workspace. */
async function teamspaceManageGate(
  c: Context<AppBindings>,
  teamspaceId: string,
): Promise<{ ok: true } | { ok: false; status: 404 }> {
  const user = c.get('user');
  const wsId = await teamspaceWorkspaceImpl(c.get('db'), teamspaceId);
  if (!wsId) return { ok: false, status: 404 };
  if (!(await isMemberImpl(c.get('db'), user.userId, wsId))) return { ok: false, status: 404 };
  return { ok: true };
}

const tsMembersSchema = z.object({ teamspaceId: z.string().uuid() });
v1Router.post('/teamspaces/members', async (c) => {
  const parsed = tsMembersSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const gate = await teamspaceManageGate(c, parsed.data.teamspaceId);
  if (!gate.ok) return c.json({ error: 'not found' }, gate.status);
  const members = await teamspaceMembersImpl(c.get('db'), parsed.data.teamspaceId);
  return c.json(members, 200);
});

const tsMemberAddSchema = z.object({
  teamspaceId: z.string().uuid(),
  query: z.string().min(1).max(255),
  role: z.enum(['member', 'admin']).default('member'),
});
v1Router.post('/teamspaces/member/add', async (c) => {
  const parsed = tsMemberAddSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const gate = await teamspaceManageGate(c, parsed.data.teamspaceId);
  if (!gate.ok) return c.json({ error: 'not found' }, gate.status);
  const added = await teamspaceMemberAddImpl(c.get('db'), {
    teamspaceId: parsed.data.teamspaceId,
    query: parsed.data.query,
    role: parsed.data.role,
  });
  if (!added) return c.json({ error: 'no user' }, 404);
  return c.json(added, 200);
});

const tsMemberRemoveSchema = z.object({
  teamspaceId: z.string().uuid(),
  userId: z.string().min(1),
});
v1Router.post('/teamspaces/member/remove', async (c) => {
  const parsed = tsMemberRemoveSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const gate = await teamspaceManageGate(c, parsed.data.teamspaceId);
  if (!gate.ok) return c.json({ error: 'not found' }, gate.status);
  const ok = await teamspaceMemberRemoveImpl(
    c.get('db'),
    parsed.data.teamspaceId,
    parsed.data.userId,
  );
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

// ---------- comments (Phase 4) ----------

// list: all comments for a page, or — with threadId — only that inline thread.
const commentsListSchema = z.object({
  pageId: z.string().uuid(),
  threadId: z.string().uuid().optional(),
});
v1Router.post('/comments/list', async (c) => {
  const user = c.get('user');
  const parsed = commentsListSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const comments = await commentsListImpl(c.get('db'), parsed.data.pageId, parsed.data.threadId);
  return c.json(comments, 200);
});

// threads: distinct open inline threads (snippet + count) for margin indicators.
const commentThreadsSchema = z.object({ pageId: z.string().uuid() });
v1Router.post('/comments/threads', async (c) => {
  const user = c.get('user');
  const parsed = commentThreadsSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const threads = await commentThreadsImpl(c.get('db'), parsed.data.pageId);
  return c.json(threads, 200);
});

const commentAddSchema = z.object({
  pageId: z.string().uuid(),
  threadId: z.string().uuid().nullish(),
  body: z.string().min(1).max(10000),
});
v1Router.post('/comments/add', async (c) => {
  const user = c.get('user');
  const parsed = commentAddSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const comment = await commentAddImpl(c.get('db'), {
    pageId: parsed.data.pageId,
    userId: user.userId,
    authorName: user.userName,
    body: parsed.data.body,
    threadId: parsed.data.threadId ?? null,
  });
  return c.json(comment, 200);
});

// resolve: either a single comment (id) or an entire inline thread
// (pageId + threadId). One of the two shapes is required.
const commentResolveSchema = z.union([
  z.object({ id: z.string().uuid(), resolved: z.boolean() }),
  z.object({ pageId: z.string().uuid(), threadId: z.string().uuid(), resolved: z.boolean() }),
]);
v1Router.post('/comments/resolve', async (c) => {
  const user = c.get('user');
  const parsed = commentResolveSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  if ('threadId' in parsed.data) {
    // Resolving a whole thread is an edit-level action (no single author).
    if (!(await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId))) {
      return c.json({ error: 'not found' }, 404);
    }
    if (!(await canEditPageImpl(c.get('db'), user.userId, parsed.data.pageId))) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const ok = await commentResolveThreadImpl(
      c.get('db'),
      parsed.data.pageId,
      parsed.data.threadId,
      parsed.data.resolved,
    );
    if (!ok) return c.json({ error: 'not found' }, 404);
    return c.json({ ok: true }, 200);
  }
  // Resolving a single comment requires edit on the page OR being its author.
  const author = await commentAuthorImpl(c.get('db'), parsed.data.id);
  if (!author) return c.json({ error: 'not found' }, 404);
  if (!(await canAccessPageImpl(c.get('db'), user.userId, author.pageId))) {
    return c.json({ error: 'not found' }, 404);
  }
  const canResolve =
    author.userId === user.userId ||
    (await canEditPageImpl(c.get('db'), user.userId, author.pageId));
  if (!canResolve) return c.json({ error: 'forbidden' }, 403);
  const ok = await commentResolveImpl(c.get('db'), parsed.data.id, parsed.data.resolved);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

v1Router.post('/comments/delete', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // Deleting a comment requires edit on the page OR being its author.
  const author = await commentAuthorImpl(c.get('db'), parsed.data.id);
  if (!author) return c.json({ error: 'not found' }, 404);
  if (!(await canAccessPageImpl(c.get('db'), user.userId, author.pageId))) {
    return c.json({ error: 'not found' }, 404);
  }
  const canDelete =
    author.userId === user.userId ||
    (await canEditPageImpl(c.get('db'), user.userId, author.pageId));
  if (!canDelete) return c.json({ error: 'forbidden' }, 403);
  const ok = await commentDeleteImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

// ---------- page version history (Phase 5) ----------
//
// Versions are captured automatically on the snapshot-write path (see
// updatePageImpl). These routes list/read/restore them; all membership-gated
// via the page's workspace (canAccessPageImpl).

const versionsListSchema = z.object({ pageId: z.string().uuid() });
v1Router.post('/pages/versions', async (c) => {
  const user = c.get('user');
  const parsed = versionsListSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const versions = await versionsListImpl(c.get('db'), parsed.data.pageId);
  return c.json(versions, 200);
});

v1Router.post('/pages/versions/get', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // Resolve the version → its page → the page's workspace for the access gate.
  const pageId = await versionPageImpl(c.get('db'), parsed.data.id);
  if (!pageId) return c.json({ error: 'not found' }, 404);
  const can = await canAccessPageImpl(c.get('db'), user.userId, pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const content = await versionGetImpl(c.get('db'), parsed.data.id);
  if (!content) return c.json({ error: 'not found' }, 404);
  return c.json(content, 200);
});

v1Router.post('/pages/versions/restore', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const pageId = await versionPageImpl(c.get('db'), parsed.data.id);
  if (!pageId) return c.json({ error: 'not found' }, 404);
  const can = await canAccessPageImpl(c.get('db'), user.userId, pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const ok = await restoreVersionImpl(c.get('db'), parsed.data.id, {
    authorId: user.userId,
    authorName: user.userName,
  });
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

// ---------- DEPRECATED: legacy flat documents (web no longer calls these) ----------

v1Router.post('/docs/list', async (c) => {
  const user = c.get('user');
  const docs = await listDocsImpl(c.get('db'), user.userId);
  return c.json(docs, 200);
});

const createSchema = z.object({ title: z.string().max(255).optional() });
v1Router.post('/docs/create', async (c) => {
  const user = c.get('user');
  const parsed = createSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const created = await createDocImpl(c.get('db'), user.userId, parsed.data.title ?? 'Untitled');
  return c.json(created, 200);
});

v1Router.post('/docs/get', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const doc = await getDocImpl(c.get('db'), user.userId, parsed.data.id);
  if (!doc) return c.json({ error: 'not found' }, 404);
  return c.json(doc, 200);
});

const updateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(255).optional(),
  snapshotHtml: z.string().optional(),
});
v1Router.post('/docs/update', async (c) => {
  const user = c.get('user');
  const parsed = updateSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const ok = await updateDocImpl(c.get('db'), user.userId, parsed.data.id, {
    title: parsed.data.title,
    snapshotHtml: parsed.data.snapshotHtml,
  });
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

v1Router.post('/docs/delete', async (c) => {
  const user = c.get('user');
  const parsed = idSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const ok = await deleteDocImpl(c.get('db'), user.userId, parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});
