// POST-only /v1 endpoints. The HMAC middleware has already verified the
// signature, parsed the JSON body into `c.var.body`, populated `c.var.user`
// (from the trusted JWT claims), and opened a per-request `c.var.db`.
//
// Every endpoint is POST-with-a-body so the HMAC scheme stays uniform.

import { Hono } from 'hono';
import { z } from 'zod';
import {
  createDocImpl,
  deleteDocImpl,
  getDocImpl,
  listDocsImpl,
  ownsDocImpl,
  searchUsersImpl,
  updateDocImpl,
} from './docs';
import { mintCollabToken } from '../lib/hmac';
import type { AppBindings } from '../context';

export const v1Router = new Hono<AppBindings>();

const idSchema = z.object({ id: z.string().uuid() });

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

const searchSchema = z.object({ q: z.string().default('') });
v1Router.post('/users/search', async (c) => {
  const parsed = searchSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const results = await searchUsersImpl(c.get('db'), parsed.data.q);
  return c.json(results, 200);
});

const collabSchema = z.object({ docId: z.string().uuid() });
v1Router.post('/collab-token', async (c) => {
  const user = c.get('user');
  const parsed = collabSchema.safeParse(c.get('body'));
  if (!parsed.success) {
    return c.json({ error: 'validation', issues: z.treeifyError(parsed.error) }, 400);
  }
  const owns = await ownsDocImpl(c.get('db'), user.userId, parsed.data.docId);
  if (!owns) return c.json({ error: 'not found' }, 404);

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
