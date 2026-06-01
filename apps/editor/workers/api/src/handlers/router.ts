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
  return c.json(page, 200);
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
