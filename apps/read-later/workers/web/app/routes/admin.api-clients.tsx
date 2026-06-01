import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import { useT } from '@allenlabs/i18n/react';
import {
  issueApiClientImpl,
  issueApiClientSchema,
  listApiClientsImpl,
} from '~/server/read-later';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { bytesToBase64 } from '~/lib/hmac';

/* v8 ignore start */
const loadClients = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await requireUser();
  return listApiClientsImpl(getDb(), me.id);
});

const issueClient = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => issueApiClientSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    // Generate a 32-byte secret, base64-encoded.
    const buf = new Uint8Array(32);
    crypto.getRandomValues(buf);
    const secret = bytesToBase64(buf);
    return issueApiClientImpl(getDb(), me.id, data, secret);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/admin/api-clients')({
  loader: async () => {
    return loadClients();
  },
  component: ApiClientsPage,
});

// ---------- presentational pieces ----------

interface IssueFormProps {
  busy?: boolean;
  onSubmit: (input: { clientId: string; name: string }) => void;
}

export function IssueForm({ busy, onSubmit }: IssueFormProps) {
  const { t } = useT();
  const [clientId, setClientId] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      data-testid="issue-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!clientId || !name) return;
        onSubmit({ clientId, name });
        setClientId('');
        setName('');
      }}
      className="card p-4 mb-6"
    >
      <h2 className="text-sm font-semibold text-slate-200 mb-3">{t('rl.issueToken')}</h2>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          name="clientId"
          placeholder={t('rl.clientIdPlaceholder')}
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className="rounded bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 flex-1"
          data-testid="client-id"
        />
        <input
          name="name"
          placeholder={t('rl.friendlyLabel')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded bg-slate-800 px-3 py-2 text-sm text-slate-100 placeholder-slate-500 flex-1"
          data-testid="client-name"
        />
        <button
          type="submit"
          disabled={busy || !clientId || !name}
          className="rounded bg-rl-600 hover:bg-rl-500 disabled:opacity-50 px-4 py-2 text-sm font-semibold text-white"
          data-testid="issue-submit"
        >
          {t('rl.issue')}
        </button>
      </div>
    </form>
  );
}

interface SecretReveal {
  clientId: string;
  hmacSecret: string;
}

export function SecretBanner({ secret }: { secret: SecretReveal }) {
  const { t } = useT();
  return (
    <div className="card p-4 mb-6 border-rl-600" data-testid="secret-banner">
      <p className="text-sm text-rl-300 mb-2">
        {t('rl.secretIssued')}
      </p>
      <div className="text-xs text-slate-400 mb-1">client_id</div>
      <code className="block break-all text-sm text-slate-100 mb-2" data-testid="secret-client-id">
        {secret.clientId}
      </code>
      <div className="text-xs text-slate-400 mb-1">hmac_secret</div>
      <code className="block break-all text-sm text-slate-100" data-testid="secret-hmac">
        {secret.hmacSecret}
      </code>
    </div>
  );
}

export function ClientList({
  clients,
}: {
  clients: Array<{ id: number; clientId: string; name: string; createdAt: string }>;
}) {
  const { t } = useT();
  if (clients.length === 0) {
    return (
      <div className="card p-4 text-sm text-slate-400" data-testid="clients-empty">
        {t('rl.noTokens')}
      </div>
    );
  }
  return (
    <ul className="space-y-2" data-testid="clients-list">
      {clients.map((c) => (
        <li key={c.id} className="card p-3 text-sm" data-testid={`client-${c.id}`}>
          <div className="flex items-baseline justify-between gap-3">
            <code className="text-slate-100">{c.clientId}</code>
            <span className="text-xs text-slate-500">
              {c.createdAt.slice(0, 10)}
            </span>
          </div>
          <div className="text-xs text-slate-400 mt-0.5">{c.name}</div>
        </li>
      ))}
    </ul>
  );
}

// ---------- page component ----------

function ApiClientsPage() {
  const clients = (Route.useLoaderData() ?? []) as Array<{
    id: number;
    clientId: string;
    name: string;
    createdAt: string;
  }>;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<SecretReveal | null>(null);
  const { t } = useT();

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-lg font-semibold text-slate-200 mb-1">{t('rl.apiTokens')}</h1>
      <p className="text-xs text-slate-500 mb-6">
        {t('rl.apiTokensSubtitle')}
      </p>
      {secret ? <SecretBanner secret={secret} /> : null}
      <IssueForm
        busy={busy}
        onSubmit={(input) => {
          /* v8 ignore next 10 — deploy smoke covers the round-trip. */
          setBusy(true);
          void issueClient({ data: input })
            .then((issued) => {
              setSecret({ clientId: issued.clientId, hmacSecret: issued.hmacSecret });
              router.invalidate();
            })
            .finally(() => setBusy(false));
        }}
      />
      <ClientList clients={clients} />
    </div>
  );
}
