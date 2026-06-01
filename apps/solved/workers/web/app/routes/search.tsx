import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import {
  searchEntriesImpl,
  type EntrySearchHit,
} from '~/server/solved';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { highlightSegments, timeAgo } from '~/lib/format';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';

const SearchInput = z.object({
  q: z.string().min(1).max(400),
  limit: z.number().int().min(1).max(100).default(50),
});

/* v8 ignore start */
const runSearch = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => SearchInput.parse(data))
  .handler(async ({ data }) => {
    const env = getEnv();
    const req = getRequest();
    const cookie = req?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    if (!token) return [];
    const payload = await verifySessionToken(env, token);
    if (!payload?.sub) return [];
    const db = getDb();
    const me = await findUserBySsoImpl(db, payload.sub);
    if (!me) return [];
    return searchEntriesImpl(db, me.id, data.q, data.limit);
  });
/* v8 ignore stop */

const SearchSchema = z.object({
  q: z.string().optional(),
});

export const Route = createFileRoute('/search')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({ q: search.q ?? '' }),
  loader: async ({ deps }) => {
    const q = deps.q.trim();
    if (!q) return { q: '', hits: [] as EntrySearchHit[] };
    const hits = await runSearch({ data: { q, limit: 50 } });
    return { q, hits };
  },
  component: SearchPage,
});

interface HighlightProps {
  headline: string;
}

export function Highlight({ headline }: HighlightProps) {
  const segments = highlightSegments(headline);
  return (
    <span data-testid="highlight">
      {segments.map((s, i) =>
        s.mark ? (
          <mark key={i} data-testid="mark">{s.text}</mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </span>
  );
}

interface SearchHitRowProps {
  hit: EntrySearchHit;
  now?: number;
}

export function SearchHitRow({ hit, now }: SearchHitRowProps) {
  const ago = timeAgo(hit.createdAt, now);
  return (
    <li className="card hover:bg-slate-800/40 transition-colors" data-testid={`hit-${hit.id}`}>
      <Link
        to="/entry/$id"
        params={{ id: String(hit.id) }}
        className="block p-3 no-underline hover:no-underline text-slate-100"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium truncate">{hit.title}</span>
          <span className="text-xs text-slate-500 shrink-0">{ago}</span>
        </div>
        {hit.headline ? (
          <p className="mt-1 text-xs text-slate-300 font-mono whitespace-pre-wrap line-clamp-3">
            <Highlight headline={hit.headline} />
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
          {hit.source ? <span className="text-solved-300">{hit.source}</span> : null}
          {hit.tags.map((t) => (
            <span key={t} className="text-slate-400">
              #{t}
            </span>
          ))}
        </div>
      </Link>
    </li>
  );
}

function SearchPage() {
  const { q, hits } = Route.useLoaderData();
  const { t } = useT();

  return (
    <>
      <Header initialQuery={q} />
      <div className="max-w-3xl mx-auto p-4">
        {!q ? (
          <p className="text-sm text-slate-400" data-testid="empty-query">
            {t('solved.search.emptyQuery')}
          </p>
        ) : hits.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="no-results">
            {t('solved.search.noResultsPrefix')}<code className="text-solved-300">{q}</code>{t('solved.search.noResultsSuffix')}
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-500 mb-3" data-testid="results-count">
              {hits.length === 1
                ? t('solved.search.countOne', { n: hits.length })
                : t('solved.search.countMany', { n: hits.length })}
              <code className="text-solved-300">{q}</code>
            </p>
            <ul className="space-y-2" data-testid="results-list">
              {hits.map((h) => (
                <SearchHitRow key={h.id} hit={h} />
              ))}
            </ul>
          </>
        )}
      </div>
    </>
  );
}
