import { createServerFn } from '@tanstack/react-start';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { type DB } from '@allenlabs/pm-core/db/client';
import { users, wikiPages, wikiRevisions, wikis } from '@allenlabs/pm-core/db/schema';
import { slugify } from '@allenlabs/pm-core/lib/format';
import { logActivityImpl } from '@allenlabs/pm-core/server/activities';
import { type CurrentUser } from './auth';
import { getDb, requirePermission } from './auth-runtime.server';

async function getOrCreateWiki(db: DB, projectId: number) {
  const existing = await db.query.wikis.findFirst({ where: eq(wikis.projectId, projectId) });
  if (existing) return existing;
  const [created] = await db.insert(wikis).values({ projectId }).returning();
  /* v8 ignore next */
  if (!created) throw new Error(`failed to create wiki for project ${projectId}`);
  return created;
}

export async function listWikiPagesImpl(db: DB, projectId: number) {
  const wiki = await getOrCreateWiki(db, projectId);
  const pages = await db
    .select({
      id: wikiPages.id,
      title: wikiPages.title,
      slug: wikiPages.slug,
      parentId: wikiPages.parentId,
      updatedAt: wikiPages.updatedAt,
    })
    .from(wikiPages)
    .where(eq(wikiPages.wikiId, wiki.id))
    .orderBy(wikiPages.title);
  return { wiki, pages };
}

export async function getWikiPageImpl(db: DB, projectId: number, slug: string) {
  const wiki = await getOrCreateWiki(db, projectId);
  const page = await db.query.wikiPages.findFirst({
    where: and(eq(wikiPages.wikiId, wiki.id), eq(wikiPages.slug, slug)),
  });
  if (!page) return { page: null, revision: null, revisions: [] };
  const revision = page.currentRevisionId
    ? await db.query.wikiRevisions.findFirst({
        where: eq(wikiRevisions.id, page.currentRevisionId),
      })
    : null;
  const revisions = await db
    .select({
      id: wikiRevisions.id,
      version: wikiRevisions.version,
      comments: wikiRevisions.comments,
      createdAt: wikiRevisions.createdAt,
      authorLogin: users.login,
    })
    .from(wikiRevisions)
    .innerJoin(users, eq(users.id, wikiRevisions.authorId))
    .where(eq(wikiRevisions.pageId, page.id))
    .orderBy(desc(wikiRevisions.version));
  return { page, revision, revisions };
}

export const saveWikiPageSchema = z.object({
  projectId: z.number(),
  slug: z.string(),
  title: z.string().min(1).max(255),
  text: z.string(),
  comments: z.string().optional().default(''),
  parentId: z.number().nullable().optional(),
});
export type SaveWikiPageInput = z.infer<typeof saveWikiPageSchema>;

export async function saveWikiPageImpl(
  db: DB,
  user: CurrentUser,
  data: SaveWikiPageInput,
) {
  const wiki = await getOrCreateWiki(db, data.projectId);
  const slug = data.slug || slugify(data.title);
  const existingPage = await db.query.wikiPages.findFirst({
    where: and(eq(wikiPages.wikiId, wiki.id), eq(wikiPages.slug, slug)),
  });
  let page: typeof wikiPages.$inferSelect;
  if (!existingPage) {
    const [created] = await db
      .insert(wikiPages)
      .values({ wikiId: wiki.id, slug, title: data.title, parentId: data.parentId ?? null })
      .returning();
    /* v8 ignore next */
    if (!created) throw new Error(`failed to create wiki page ${slug}`);
    page = created;
  } else {
    await db
      .update(wikiPages)
      .set({ title: data.title, parentId: data.parentId ?? null, updatedAt: new Date() })
      .where(eq(wikiPages.id, existingPage.id));
    page = existingPage;
  }
  const previous = await db
    .select({ version: wikiRevisions.version })
    .from(wikiRevisions)
    .where(eq(wikiRevisions.pageId, page.id))
    .orderBy(desc(wikiRevisions.version))
    .limit(1);
  const nextVersion = (previous[0]?.version ?? 0) + 1;
  const [revision] = await db
    .insert(wikiRevisions)
    .values({
      pageId: page.id,
      authorId: user.id,
      text: data.text,
      comments: data.comments,
      version: nextVersion,
    })
    .returning();
  /* v8 ignore next */
  if (!revision) throw new Error(`failed to create wiki revision for page ${page.id}`);
  await db
    .update(wikiPages)
    .set({ currentRevisionId: revision.id })
    .where(eq(wikiPages.id, page.id));

  // Refetch so the returned page reflects the latest title + currentRevisionId.
  const refreshed = await db.query.wikiPages.findFirst({ where: eq(wikiPages.id, page.id) });
  /* v8 ignore next */
  if (!refreshed) throw new Error(`wiki page ${page.id} not found after update`);
  page = refreshed;

  await logActivityImpl(db, {
    projectId: data.projectId,
    userId: user.id,
    kind: 'wiki_edited',
    refId: page.id,
    title: `${user.login} edited wiki page ${data.title}`,
    body: data.comments,
  });

  return { page, revision };
}

export async function deleteWikiPageImpl(db: DB, id: number) {
  await db.delete(wikiPages).where(eq(wikiPages.id, id));
  return { ok: true };
}

// ---------- wrappers ----------
// Exercised by wrangler integration tests in tests/workers/.
/* v8 ignore start */

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
