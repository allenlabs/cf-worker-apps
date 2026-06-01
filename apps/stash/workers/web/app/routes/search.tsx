import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { z } from 'zod';
import {
  searchSnippetsImpl,
  type SnippetSearchHit,
} from '~/server/stash';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { highlightSegments, languageLabel, timeAgo } from '~/lib/format';
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
    return searchSnippetsImpl(db, me.id, data.q, data.limit);
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
    if (!q) return { q: '', hits: [] as SnippetSearchHit[] };
    const hits = await runSearch({ data: { q, limit: 50 } });
    return { q, hits };
  },
  component: SearchPage,
});

// ---------- presentational helpers (exported for tests) ----------

interface HighlightProps {
  /** Postgres ts_headline output with `<b>...</b>` markers. */
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
  hit: SnippetSearchHit;
  now?: number;
}

export function SearchHitRow({ hit, now }: SearchHitRowProps) {
  const { t } = useT();
  const ago = timeAgo(hit.createdAt, now);
  const lang = languageLabel(hit.language);
  const title = hit.title || t('stash.untitled');
  return (
    <li className="card hover:bg-slate-800/40 transition-colors" data-testid={`hit-${hit.id}`}>
      <Link
        to="/snippet/$id"
        params={{ id: String(hit.id) }}
        className="block p-3 no-underline hover:no-underline text-slate-100"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium truncate">{title}</span>
          <span className="text-xs text-slate-500 shrink-0">{ago}</span>
        </div>
        {hit.headline ? (
          <p className="mt-1 text-xs text-slate-300 font-mono whitespace-pre-wrap line-clamp-3">
            <Highlight headline={hit.headline} />
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap gap-2 text-xs text-slate-500">
          {lang ? <span className="text-stash-300">{lang}</span> : null}
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

// ---------- page ----------

function SearchPage() {
  const { q, hits } = Route.useLoaderData();
  const { t } = useT();

  return (
    <>
      <Header initialQuery={q} />
      <div className="max-w-3xl mx-auto p-4">
        {!q ? (
          <p className="text-sm text-slate-400" data-testid="empty-query">
            {t('stash.typeQuery')}
          </p>
        ) : hits.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="no-results">
            {t('stash.noMatchesFor')} <code className="text-stash-300">{q}</code>.
          </p>
        ) : (
          <>
            <p className="text-xs text-slate-500 mb-3" data-testid="results-count">
              {t(hits.length === 1 ? 'stash.matchOne' : 'stash.matchMany', { n: hits.length })}{' '}
              <code className="text-stash-300">{q}</code>
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
