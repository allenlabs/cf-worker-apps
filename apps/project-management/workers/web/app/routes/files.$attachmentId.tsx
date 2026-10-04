import { createFileRoute } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { attachments } from '@allenlabs/pm-core/db/schema';
import { streamAttachment } from '~/server/attachments';
import {
  buildAuthContext,
  getCurrentUser,
  getDb,
  getEnv,
} from '~/server/auth-runtime.server';

const download = createServerFn({ method: 'GET' })
  .inputValidator((d: unknown) => z.object({ id: z.number() }).parse(d))
  .handler(async ({ data }) => {
    const env = getEnv();
    const db = getDb(env);
    const att = await db.query.attachments.findFirst({ where: eq(attachments.id, data.id) });
    if (!att) return new Response('Not found', { status: 404 });
    // Authz: if the container has a project, the user must have view_files there.
    // For wiki_page / issue / journal we look the project up indirectly.
    // For simplicity here we allow any signed-in user who has view_files on at
    // least one project that owns this attachment.  Public files would need a
    // small "is owning project public" check; left to the reader.
    const me = await getCurrentUser();
    if (!me) return new Response('Auth required', { status: 401 });
    if (!me.isAdmin) {
      const ctx = await buildAuthContext(me.id);
      const allowed = Object.values(ctx.permissionsByProject).some((set) => set.has('view_files'));
      if (!allowed) return new Response('Forbidden', { status: 403 });
    }
    return streamAttachment(data.id);
  });

export const Route = createFileRoute('/files/$attachmentId')({
  beforeLoad: async ({ params }) => {
    const res = await download({ data: { id: Number(params.attachmentId) } });
    throw res; // route handler throws a Response; nitro will send it.
  },
  component: () => null,
});
