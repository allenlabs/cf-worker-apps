// POST-only /v1 endpoints. The HMAC middleware has already verified the
// signature, parsed the JSON body into `c.var.body`, populated `c.var.user`
// (from the trusted JWT claims), and opened a per-request `c.var.db`.
//
// Every endpoint is POST-with-a-body so the HMAC scheme stays uniform.
//
// Phase 1 (workspaces + page tree) lives under /v1/workspaces/* and /v1/pages/*.
// The legacy flat /v1/docs/* endpoints remain (DEPRECATED) for any old client;
// the web no longer calls them. New code reads/writes editor.pages.

import { Hono } from 'hono';
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
  createPageImpl,
  getPageImpl,
  isMemberImpl,
  listOrProvisionWorkspacesImpl,
  movePageImpl,
  pageTreeImpl,
  updatePageImpl,
} from './pages';
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
  propertyDatabaseImpl,
  rowDatabaseImpl,
  updatePropertyImpl,
  updateRowImpl,
  updateViewImpl,
  viewDatabaseImpl,
} from './db';
import { prepareUpload, publicUrlFor } from './files';
import {
  commentAddImpl,
  commentDeleteImpl,
  commentPageImpl,
  commentResolveImpl,
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
  const created = await createPageImpl(c.get('db'), user.userId, {
    workspaceId: parsed.data.workspaceId,
    parentId: parsed.data.parentId ?? null,
    title: parsed.data.title,
    icon: parsed.data.icon ?? null,
  });
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
  const member = await isMemberImpl(c.get('db'), user.userId, page.workspaceId);
  if (!member) return c.json({ error: 'not found' }, 404);
  const favorited = await isFavoritedImpl(c.get('db'), user.userId, page.id);
  return c.json({ ...page, favorited }, 200);
});

const updatePageSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(255).optional(),
  icon: z.string().max(32).nullish(),
  snapshotHtml: z.string().optional(),
});
v1Router.post('/pages/update', async (c) => {
  const user = c.get('user');
  const parsed = updatePageSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!can) return c.json({ error: 'not found' }, 404);
  const ok = await updatePageImpl(c.get('db'), parsed.data.id, {
    title: parsed.data.title,
    icon: parsed.data.icon === undefined ? undefined : parsed.data.icon ?? null,
    snapshotHtml: parsed.data.snapshotHtml,
  });
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

const movePageSchema = z.object({
  id: z.string().uuid(),
  parentId: z.string().uuid().nullish(),
  position: z.number().optional(),
});
v1Router.post('/pages/move', async (c) => {
  const user = c.get('user');
  const parsed = movePageSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!can) return c.json({ error: 'not found' }, 404);
  // A new parent (when given) must be in the same workspace and accessible.
  if (parsed.data.parentId) {
    const can2 = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.parentId);
    if (!can2) return c.json({ error: 'not found' }, 404);
  }
  let ok: boolean;
  try {
    ok = await movePageImpl(c.get('db'), {
      id: parsed.data.id,
      parentId: parsed.data.parentId === undefined ? undefined : parsed.data.parentId ?? null,
      position: parsed.data.position,
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
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!can) return c.json({ error: 'not found' }, 404);
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

// ---------- collab token (now membership-gated; docId === pageId) ----------

const collabSchema = z.object({ docId: z.string().uuid() });
v1Router.post('/collab-token', async (c) => {
  const user = c.get('user');
  const parsed = collabSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  // The page's workspace must include this user. (docId is the page id.)
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.docId);
  if (!can) return c.json({ error: 'not found' }, 404);

  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    room: parsed.data.docId,
    exp: nowSec + 3600,
    uid: user.userId,
    name: user.userName,
  };
  const token = await mintCollabToken(c.env.COLLAB_HMAC_SECRET, payload);
  return c.json({ token, url: c.env.COLLAB_URL, docId: parsed.data.docId }, 200);
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
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.databaseId);
  if (!can) return c.json({ error: 'not found' }, 404);
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
  const can = await canAccessPageImpl(c.get('db'), user.userId, dbId);
  if (!can) return c.json({ error: 'not found' }, 404);
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
  const can = await canAccessPageImpl(c.get('db'), user.userId, dbId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const ok = await deletePropertyImpl(c.get('db'), parsed.data.id);
  if (!ok) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200);
});

const viewAddSchema = z.object({
  databaseId: z.string().uuid(),
  type: z.enum(['table', 'board']),
  name: z.string().max(120).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
v1Router.post('/db/view/add', async (c) => {
  const user = c.get('user');
  const parsed = viewAddSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.databaseId);
  if (!can) return c.json({ error: 'not found' }, 404);
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
  const can = await canAccessPageImpl(c.get('db'), user.userId, dbId);
  if (!can) return c.json({ error: 'not found' }, 404);
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
  const can = await canAccessPageImpl(c.get('db'), user.userId, dbId);
  if (!can) return c.json({ error: 'not found' }, 404);
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
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.databaseId);
  if (!can) return c.json({ error: 'not found' }, 404);
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
  // Rows are pages; canAccessPageImpl resolves the row's workspace directly.
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!can) return c.json({ error: 'not found' }, 404);
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
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.id);
  if (!can) return c.json({ error: 'not found' }, 404);
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

// ---------- comments (Phase 4) ----------

const commentsListSchema = z.object({ pageId: z.string().uuid() });
v1Router.post('/comments/list', async (c) => {
  const user = c.get('user');
  const parsed = commentsListSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const can = await canAccessPageImpl(c.get('db'), user.userId, parsed.data.pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const comments = await commentsListImpl(c.get('db'), parsed.data.pageId);
  return c.json(comments, 200);
});

const commentAddSchema = z.object({ pageId: z.string().uuid(), body: z.string().min(1).max(10000) });
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
  });
  return c.json(comment, 200);
});

const commentResolveSchema = z.object({ id: z.string().uuid(), resolved: z.boolean() });
v1Router.post('/comments/resolve', async (c) => {
  const user = c.get('user');
  const parsed = commentResolveSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const pageId = await commentPageImpl(c.get('db'), parsed.data.id);
  if (!pageId) return c.json({ error: 'not found' }, 404);
  const can = await canAccessPageImpl(c.get('db'), user.userId, pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
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
  // Any workspace member may delete (author check is a subset of membership);
  // we gate on access to the comment's page.
  const pageId = await commentPageImpl(c.get('db'), parsed.data.id);
  if (!pageId) return c.json({ error: 'not found' }, 404);
  const can = await canAccessPageImpl(c.get('db'), user.userId, pageId);
  if (!can) return c.json({ error: 'not found' }, 404);
  const ok = await commentDeleteImpl(c.get('db'), parsed.data.id);
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
