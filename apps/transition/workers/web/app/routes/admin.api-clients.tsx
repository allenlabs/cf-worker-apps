import { createFileRoute, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { useState } from 'react';
import {
  createApiClientImpl,
  createApiClientSchema,
  deleteApiClientImpl,
  listApiClientsImpl,
  type ApiClientListItem,
} from '~/server/transition';
import { getDb, requireUser } from '~/server/auth-runtime.server';
import { Header } from '~/components/Header';
import { useT } from '@allenlabs/i18n/react';
import { z } from 'zod';

/* v8 ignore start */
const loadClients = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await requireUser();
  return listApiClientsImpl(getDb(), me.id);
});

const createClient = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => createApiClientSchema.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return createApiClientImpl(getDb(), me.id, data);
  });

const deleteClient = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => z.object({ clientId: z.string() }).parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return deleteApiClientImpl(getDb(), me.id, data.clientId);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/admin/api-clients')({
  loader: async () => {
    const clients = await loadClients();
    return { clients };
  },
  component: AdminPage,
});

interface ClientRowProps {
  client: ApiClientListItem;
  onDelete?: (clientId: string) => void;
}

export function ClientRow({ client, onDelete }: ClientRowProps) {
  const { t } = useT();
  return (
    <li
      className="card flex items-center justify-between gap-3 p-3"
      data-testid={`client-${client.clientId}`}
    >
      <div>
        <div className="font-mono text-sm text-slate-100">{client.clientId}</div>
        <div className="text-xs text-slate-400 mt-0.5">{client.name}</div>
      </div>
      <button
        type="button"
        onClick={() => onDelete?.(client.clientId)}
        className="text-xs text-slate-400 hover:text-red-300 underline"
        data-testid={`delete-${client.clientId}`}
      >
        {t('admin.apiClients.revoke')}
      </button>
    </li>
  );
}

interface NewClientFormProps {
  onSubmit: (clientId: string, name: string) => void;
  busy?: boolean;
  error?: string | null;
}

export function NewClientForm({ onSubmit, busy, error }: NewClientFormProps) {
  const { t } = useT();
  const [clientId, setClientId] = useState('');
  const [name, setName] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!clientId.trim() || !name.trim()) return;
        onSubmit(clientId.trim(), name.trim());
      }}
      className="card p-3 space-y-2"
      data-testid="new-client-form"
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <input
          type="text"
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={t('admin.apiClients.clientIdPlaceholder')}
          aria-label={t('admin.apiClients.clientIdLabel')}
          className="rounded bg-slate-950 border border-slate-800 px-3 py-2 text-sm font-mono text-slate-100 focus:border-transition-500 focus:outline-none"
          data-testid="new-client-id"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('admin.apiClients.namePlaceholder')}
          aria-label={t('admin.apiClients.nameLabel')}
          className="rounded bg-slate-950 border border-slate-800 px-3 py-2 text-sm text-slate-100 focus:border-transition-500 focus:outline-none"
          data-testid="new-client-name"
        />
      </div>
      {error ? <p className="text-sm text-red-400" data-testid="new-client-error">{error}</p> : null}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={busy || !clientId.trim() || !name.trim()}
          className="rounded bg-transition-600 hover:bg-transition-500 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-sm font-semibold text-white"
          data-testid="new-client-submit"
        >
          {busy ? t('admin.apiClients.issuing') : t('admin.apiClients.issue')}
        </button>
      </div>
    </form>
  );
}

interface IssuedSecretProps {
  clientId: string;
  hmacSecret: string;
  onDismiss: () => void;
}

export function IssuedSecret({ clientId, hmacSecret, onDismiss }: IssuedSecretProps) {
  const { t } = useT();
  return (
    <div className="card border-transition-700 bg-transition-900/30 p-3" data-testid="issued-secret">
      <div className="text-sm font-semibold text-transition-200">
        {t('admin.apiClients.saveNow')}
      </div>
      <dl className="mt-2 text-xs font-mono text-slate-200 space-y-1">
        <div>
          <dt className="text-slate-500 inline">X-Client-Id:</dt>{' '}
          <dd className="inline">{clientId}</dd>
        </div>
        <div>
          <dt className="text-slate-500 inline">HMAC secret:</dt>{' '}
          <dd className="inline break-all" data-testid="issued-secret-value">
            {hmacSecret}
          </dd>
        </div>
      </dl>
      <button
        type="button"
        onClick={onDismiss}
        className="mt-2 text-xs text-slate-300 hover:text-slate-100 underline"
        data-testid="dismiss-issued"
      >
        {t('admin.apiClients.dismiss')}
      </button>
    </div>
  );
}

function AdminPage() {
  const { clients } = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ clientId: string; hmacSecret: string } | null>(null);

  /* v8 ignore start */
  async function handleCreate(clientId: string, name: string) {
    setError(null);
    setBusy(true);
    try {
      const created = await createClient({ data: { clientId, name } });
      setIssued({ clientId: created.clientId, hmacSecret: created.hmacSecret });
      router.invalidate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(clientId: string) {
    if (!confirm(t('admin.apiClients.revokeConfirm', { clientId }))) return;
    setBusy(true);
    try {
      await deleteClient({ data: { clientId } });
      router.invalidate();
    } finally {
      setBusy(false);
    }
  }
  /* v8 ignore stop */

  return (
    <>
      <Header />
      <div className="max-w-3xl mx-auto p-4">
        <h1 className="text-lg font-semibold text-slate-200 mb-1">{t('admin.apiClients.title')}</h1>
        <p className="text-xs text-slate-500 mb-4">{t('admin.apiClients.subtitle')}</p>
        {issued ? (
          <div className="mb-4">
            <IssuedSecret
              clientId={issued.clientId}
              hmacSecret={issued.hmacSecret}
              onDismiss={() => setIssued(null)}
            />
          </div>
        ) : null}
        <div className="mb-6">
          <NewClientForm onSubmit={handleCreate} busy={busy} error={error} />
        </div>
        {clients.length === 0 ? (
          <p className="text-sm text-slate-400" data-testid="no-clients">{t('admin.apiClients.empty')}</p>
        ) : (
          <ul className="space-y-2" data-testid="clients-list">
            {clients.map((c) => (
              <ClientRow key={c.clientId} client={c} onDelete={handleDelete} />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
