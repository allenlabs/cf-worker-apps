import { createFileRoute, Link } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { listPagedImpl, type EventRow } from '~/server/dopamine';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { EventCard } from '~/components/EventCard';
import { useT } from '@allenlabs/i18n/react';

const PAGE_SIZE = 50;

/* v8 ignore start */
const loadPage = createServerFn({ method: 'GET' })
  .inputValidator((data: unknown) =>
    z.object({ page: z.number().int().min(0).default(0) }).parse(data),
  )
  .handler(async ({ data }) => {
    const me = await requireUser();
    const events = await listPagedImpl(getDb(), me.id, PAGE_SIZE, data.page * PAGE_SIZE);
    return { events, page: data.page };
  });
/* v8 ignore stop */

const SearchSchema = z.object({ page: z.coerce.number().int().min(0).default(0) });

export const Route = createFileRoute('/all')({
  validateSearch: SearchSchema,
  loaderDeps: ({ search }) => ({ page: search.page }),
  loader: async ({ deps }) => loadPage({ data: { page: deps.page } }),
  component: AllPage,
});

function AllPage() {
  const data = Route.useLoaderData() as { events: EventRow[]; page: number };
  const hasMore = data.events.length >= PAGE_SIZE;
  const { t } = useT();
  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <div className="flex items-baseline justify-between">
          <h1 className="text-base font-semibold text-slate-200">
            {t('dopamine.allWins', { n: data.page + 1 })}
          </h1>
          <Link to="/" className="text-xs">{t('dopamine.back')}</Link>
        </div>
        {data.events.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="empty-page">{t('dopamine.emptyPage')}</p>
        ) : (
          <ul className="space-y-2" data-testid="all-list">
            {data.events.map((e) => <EventCard key={e.id} event={e} />)}
          </ul>
        )}
        <div className="flex items-center justify-between text-sm pt-2">
          {data.page > 0 ? (
            <Link to="/all" search={{ page: data.page - 1 }} data-testid="prev-page">
              {t('dopamine.prevPage')}
            </Link>
          ) : <span />}
          {hasMore ? (
            <Link to="/all" search={{ page: data.page + 1 }} data-testid="next-page">
              {t('dopamine.nextPage')}
            </Link>
          ) : <span />}
        </div>
      </div>
    </>
  );
}
