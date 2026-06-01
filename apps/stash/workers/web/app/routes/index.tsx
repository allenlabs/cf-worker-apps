import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import {
  loadHomeImpl,
  type HomePayload,
  type SnippetSummary,
} from '~/server/stash';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { bodyPreview, languageLabel, paginationPages, timeAgo } from '~/lib/format';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';

const HomeInput = z.object({ page: z.number().int().min(1).max(10_000).default(1) });

/* v8 ignore start */
const loadHome = createServerFn({ method: 'GET' })
  .inputValidator((data: unknown) => HomeInput.parse(data ?? {}))
  .handler(async ({ data }) => {
    const env = getEnv();
    const req = getRequest();
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    if (!token) return null;
    const payload = await verifySessionToken(env, token);
    if (!payload?.sub) return null;
    return loadHomeImpl(getDb(), payload.sub, data.page, 20);
  });
/* v8 ignore stop */

const SearchSchema = z.object({ page: z.coerce.number().int().min(1).max(10_000).optional() });

export const Route = createFileRoute('/')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({ page: search.page ?? 1 }),
  loader: async ({ deps }) => {
    const data = await loadHome({ data: { page: deps.page } });
    return data;
  },
  component: HomePage,
});

// ---------- presentational helpers (exported for tests) ----------

interface SnippetCardInnerProps {
  snippet: SnippetSummary;
  now?: number;
}

export function SnippetCardInner({ snippet, now }: SnippetCardInnerProps) {
  const { t } = useT();
  const ago = timeAgo(snippet.createdAt, now);
  const lang = languageLabel(snippet.language);
  const title = snippet.title || bodyPreview(snippet.body, 80) || t('stash.untitled');
  return (
    <div className="block p-3 text-slate-100" data-testid={`card-${snippet.id}`}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium truncate">{title}</span>
        <span className="text-xs text-slate-500 shrink-0">{ago}</span>
      </div>
      {snippet.title ? (
        <p className="mt-1 text-xs text-slate-400 line-clamp-2">{bodyPreview(snippet.body, 200)}</p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
        {lang ? <span className="text-stash-300" data-testid={`lang-${snippet.id}`}>{lang}</span> : null}
        {snippet.tags.map((t) => (
          <span key={t} className="text-slate-400" data-testid={`tag-${snippet.id}-${t}`}>
            #{t}
          </span>
        ))}
      </div>
    </div>
  );
}

export function SnippetCard({ snippet, now }: SnippetCardInnerProps) {
  return (
    <li className="card hover:bg-slate-800/40 transition-colors">
      <Link
        to="/snippet/$id"
        params={{ id: String(snippet.id) }}
        className="block no-underline hover:no-underline"
        data-testid={`link-${snippet.id}`}
      >
        <SnippetCardInner snippet={snippet} now={now} />
      </Link>
    </li>
  );
}

export function EmptyState() {
  const { t } = useT();
  return (
    <div className="card p-6 text-center text-sm text-slate-400" data-testid="empty-state">
      <p className="mb-2 text-slate-200">{t('stash.emptyTitle')}</p>
      <p className="text-xs">
        <Link to="/new" className="text-stash-300">{t('stash.new')}</Link>
      </p>
    </div>
  );
}

interface PaginatorProps {
  page: number;
  total: number;
  pageSize: number;
  basePath: string;
  query?: Record<string, string>;
}

export function Paginator({ page, total, pageSize, basePath, query }: PaginatorProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (totalPages <= 1) return null;
  const pages = paginationPages(page, totalPages);
  return (
    <nav
      className="mt-6 flex items-center justify-center gap-1 text-sm"
      aria-label="Pagination"
      data-testid="paginator"
    >
      {pages.map((p, i) =>
        p === '…' ? (
          <span key={`gap-${i}`} className="px-2 text-slate-500">
            …
          </span>
        ) : (
          <Link
            key={p}
            to={basePath}
            search={{ ...(query ?? {}), page: p }}
            className={`px-2.5 py-1 rounded ${
              p === page
                ? 'bg-stash-600 text-white hover:no-underline'
                : 'text-slate-300 hover:bg-slate-800'
            }`}
            data-testid={`page-${p}`}
          >
            {p}
          </Link>
        ),
      )}
    </nav>
  );
}

// ---------- page ----------

function HomePage() {
  const data = Route.useLoaderData() as HomePayload | null;
  const search = Route.useSearch();
  const page = search.page ?? 1;
  const { t } = useT();

  if (!data) {
    return <div className="p-6 text-slate-400">{t('state.loading')}</div>;
  }

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        {data.snippets.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            <ul className="space-y-2" data-testid="snippet-list">
              {data.snippets.map((s) => (
                <SnippetCard key={s.id} snippet={s} />
              ))}
            </ul>
            <Paginator
              page={page}
              total={data.total}
              pageSize={data.pageSize}
              basePath="/"
            />
          </>
        )}
      </div>
    </>
  );
}
