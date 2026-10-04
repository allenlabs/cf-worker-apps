import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import {
  loadHomeImpl,
  setIntentImpl,
  setIntentSchema,
  type HomePayload,
} from '~/server/intent';
import { getDb, requireUser, getEnv } from '~/server/auth-runtime.server';
import { getRequest } from '@tanstack/react-start/server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import { Header } from '~/components/Header';
import { IntentEditor } from '~/components/IntentEditor';
import { useT } from '@allenlabs/i18n/react';

/* v8 ignore start */
const loadHome = createServerFn({ method: 'GET' }).handler(async () => {
  const env = getEnv();
  let req: Request | undefined;
  try { req = getRequest(); } catch { return null; }
  const cookie = req?.headers.get('cookie') ?? null;
  const token = readSessionToken(cookie);
  if (!token) return null;
  const payload = await verifySessionToken(env, token);
  if (!payload?.sub) return null;
  return loadHomeImpl(getDb(), payload.sub);
});

const saveIntent = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => setIntentSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return setIntentImpl(getDb(), me.id, data);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/')({
  loader: async () => loadHome(),
  component: HomePage,
});

export function NoSession() {
  const { t } = useT();
  return (
    <div className="card p-4 text-sm text-slate-400" data-testid="no-session">
      {t('state.signedOut')}
    </div>
  );
}

function HomePage() {
  const data = Route.useLoaderData() as HomePayload | null;
  const router = useRouter();
  const { t } = useT();

  if (!data) {
    return <NoSession />;
  }

  /* v8 ignore start — server round-trip covered via deploy smoke. */
  async function handleSave(text: string) {
    await saveIntent({ data: { text } });
    router.invalidate();
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4 space-y-4">
        <h1 className="text-base font-semibold text-slate-200">
          {t('intent.heading')}
        </h1>
        <IntentEditor
          initialText={data.current.text}
          updatedAt={data.current.updatedAt}
          onSave={handleSave}
        />
      </div>
    </>
  );
}
