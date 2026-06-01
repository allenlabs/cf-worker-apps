// PUBLIC read-only share route (Phase 4). Reachable signed-out — it has NO
// beforeLoad auth gate and its path prefix (/share/) is exempted from the
// __root SSO redirect (see PUBLIC_PATH_PREFIXES there). It fetches the page via
// the no-user `publicPage` server fn (which hits editor-api's public route),
// and renders title + icon + the snapshot HTML read-only. A non-public or
// missing page yields a 404-style "not available" message.

import { createFileRoute } from '@tanstack/react-router';
import { publicPage, type PublicPage } from '~/server/docs';

export const Route = createFileRoute('/share/$pageId')({
  // NOTE: intentionally NO beforeLoad — public visitors must reach this.
  loader: async ({ params }) => {
    if (typeof document !== 'undefined') {
      return { page: null as PublicPage | null };
    }
    try {
      const page = await publicPage({ data: { id: params.pageId } });
      return { page };
    } catch {
      return { page: null as PublicPage | null };
    }
  },
  component: SharePage,
});

function SharePage() {
  const { page } = Route.useLoaderData();

  if (!page) {
    return (
      <div className="max-w-2xl mx-auto px-8 py-16 text-center">
        <h1 className="text-xl font-semibold mb-2">Page not available</h1>
        <p className="text-gray-500">
          This page is private or no longer shared.
        </p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto px-8 py-10">
      <div className="flex items-center gap-2 mb-6">
        {page.icon ? <span className="text-3xl">{page.icon}</span> : null}
        <h1 className="text-3xl font-bold">{page.title || 'Untitled'}</h1>
      </div>
      {/* snapshotHtml is produced by our own editor; rendered read-only. */}
      <div
        className="editor-readonly prose max-w-none"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: sanitize(page.snapshotHtml) }}
      />
    </div>
  );
}

/**
 * Minimal defense-in-depth sanitizer: strip <script>/<style>, inline event
 * handlers, and javascript: URLs. The content originates from our own editor
 * (server-stored snapshot), but the public route is unauthenticated so we
 * scrub the obvious script-injection vectors before injecting.
 */
export function sanitize(html: string): string {
  return html
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son\w+\s*=\s*'[^']*'/gi, '')
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, '')
    .replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'");
}
