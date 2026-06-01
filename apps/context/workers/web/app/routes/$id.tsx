import { createFileRoute, Link, useRouter } from '@tanstack/react-router';
import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { useState } from 'react';
import {
  deleteSnapshotImpl,
  getSnapshotImpl,
  restoreSnapshotImpl,
  type SnapshotDetail,
} from '~/server/context';
import { findUserBySsoImpl } from '~/server/users';
import { getDb, getEnv, requireUser } from '~/server/auth-runtime.server';
import { readSessionToken, verifySessionToken } from '~/server/session.server';
import {
  isRecognisedKey,
  payloadKeyLabel,
  previewValue,
  RECOGNISED_KEYS,
  restoreCountLabel,
  timeAgo,
} from '~/lib/format';
import { useT } from '@allenlabs/i18n/react';

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const IdInput = z.object({ id: z.number().int().positive() });

/* v8 ignore start */
const loadSnapshot = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const env = getEnv();
    const cookie = (await import('@tanstack/react-start/server')).getRequest()?.headers.get('cookie') ?? null;
    const token = readSessionToken(cookie);
    if (!token) return null;
    const payload = await verifySessionToken(env, token);
    if (!payload?.sub) return null;
    const db = getDb();
    const me = await findUserBySsoImpl(db, payload.sub);
    if (!me) return null;
    return getSnapshotImpl(db, me.id, data.id);
  });

const restoreSnapshot = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return restoreSnapshotImpl(getDb(), me.id, data.id);
  });

const deleteSnapshot = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => IdInput.parse(data))
  .handler(async ({ data }) => {
    const me = await requireUser();
    return deleteSnapshotImpl(getDb(), me.id, data.id);
  });
/* v8 ignore stop */

export const Route = createFileRoute('/$id')({
  loader: async ({ params }) => {
    const id = Number(params.id);
    if (!Number.isFinite(id) || id <= 0) return null;
    const data = await loadSnapshot({ data: { id } });
    return data;
  },
  component: DetailPage,
});

// ---------- presentational helpers (exported for tests) ----------

interface PayloadTableProps {
  payload: Record<string, unknown>;
}

/**
 * Render `payload` as a 2-column table.  Recognised keys (cwd, branch,
 * files, tabs, processes, terminals) come first in a curated order so the
 * eye lands on the "most-restore-able" pieces; everything else follows in
 * alphabetical key order.
 */
export function PayloadTable({ payload }: PayloadTableProps) {
  const { t } = useT();
  const keys = Object.keys(payload);
  const recognisedInOrder = RECOGNISED_KEYS.filter((k) => keys.includes(k));
  const unrecognised = keys
    .filter((k) => !isRecognisedKey(k))
    .sort((a, b) => a.localeCompare(b));
  const ordered = [...recognisedInOrder, ...unrecognised];
  if (ordered.length === 0) {
    return (
      <div className="card p-3 text-xs text-slate-500" data-testid="payload-empty">
        {t('context.noPayload')}
      </div>
    );
  }
  return (
    <table className="w-full text-sm" data-testid="payload-table">
      <tbody>
        {ordered.map((k) => {
          const v = payload[k];
          const recognised = isRecognisedKey(k);
          return (
            <tr key={k} className="border-b border-slate-800 last:border-0">
              <th
                scope="row"
                className="text-left text-xs font-medium text-slate-400 align-top w-1/3 py-2 pr-3"
              >
                {payloadKeyLabel(k)}
              </th>
              <td className="py-2 align-top text-slate-200" data-testid={`payload-${k}`}>
                {recognised ? (
                  renderRecognisedValue(k, v, t)
                ) : (
                  <pre className="whitespace-pre-wrap break-all text-xs text-slate-300">
                    {JSON.stringify(v, null, 2)}
                  </pre>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function renderRecognisedValue(key: string, value: unknown, t: Translate): React.ReactNode {
  // Render arrays of strings as bullet lists, plain strings as <code>.
  if (typeof value === 'string') {
    return <code className="break-all text-ctx-300">{value}</code>;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="text-xs text-slate-500">{t('context.empty.paren')}</span>;
    }
    return (
      <ul className="space-y-1" data-testid={`list-${key}`}>
        {value.slice(0, 50).map((item, i) => (
          <li key={i} className="text-xs">
            <code className="text-ctx-300 break-all">{previewValue(item)}</code>
          </li>
        ))}
        {value.length > 50 ? (
          <li className="text-xs text-slate-500">{t('context.moreItems', { n: value.length - 50 })}</li>
        ) : null}
      </ul>
    );
  }
  return <code className="text-ctx-300 break-all">{previewValue(value)}</code>;
}

interface DetailHeaderProps {
  snapshot: SnapshotDetail;
  now?: number;
}

export function DetailHeader({ snapshot, now }: DetailHeaderProps) {
  const { t } = useT();
  return (
    <div className="mb-6" data-testid="detail-header">
      <h1 className="text-xl font-semibold text-slate-100">{snapshot.name}</h1>
      <div className="mt-1 flex flex-wrap gap-3 text-xs text-slate-500">
        <span>{t('context.captured', { when: timeAgo(snapshot.createdAt, now) })}</span>
        <span>· {restoreCountLabel(snapshot.restoredCount)}</span>
        {snapshot.restoredAt ? (
          <span>· {t('context.lastRestored', { when: timeAgo(snapshot.restoredAt, now) })}</span>
        ) : null}
      </div>
    </div>
  );
}

interface LinkedEntitiesProps {
  snapshot: Pick<SnapshotDetail, 'focusSessionId' | 'pmIssueId' | 'inboxItemId'>;
}

export function LinkedEntities({ snapshot }: LinkedEntitiesProps) {
  const { t } = useT();
  const items: Array<{ label: string; href: string }> = [];
  if (snapshot.focusSessionId) {
    items.push({
      label: t('context.focusSession', { id: snapshot.focusSessionId }),
      href: `https://focus.allenlabs.org/history`,
    });
  }
  if (snapshot.inboxItemId) {
    items.push({
      label: t('context.inboxItem', { id: snapshot.inboxItemId }),
      href: `https://inbox.allenlabs.org/`,
    });
  }
  if (snapshot.pmIssueId) {
    items.push({
      label: t('context.pmIssue', { id: snapshot.pmIssueId }),
      href: `https://projects.allenlabs.org/issues/${snapshot.pmIssueId}`,
    });
  }
  if (items.length === 0) return null;
  return (
    <div className="card p-3 mb-4" data-testid="linked-entities">
      <div className="text-xs text-slate-500 mb-2">{t('context.linkedAtCapture')}</div>
      <ul className="space-y-1 text-sm">
        {items.map((it) => (
          <li key={it.href}>
            <a href={it.href} className="text-ctx-300 hover:underline" target="_blank" rel="noreferrer">
              {it.label} →
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The "I'm back" button: bumps restored_at + restored_count and (when the
 * payload carries `cwd` and/or `branch`) copies a `cd … && git switch …`
 * one-liner to clipboard.  Browser-only — no shell-side restoration from
 * the web.  Returns the shell snippet so tests can assert against it.
 */
export function buildRestoreSnippet(payload: Record<string, unknown>): string | null {
  const cwd = typeof payload.cwd === 'string' ? payload.cwd : null;
  const branch = typeof payload.branch === 'string' ? payload.branch : null;
  if (!cwd && !branch) return null;
  const parts: string[] = [];
  if (cwd) parts.push(`cd ${shellQuote(cwd)}`);
  if (branch) parts.push(`git switch ${shellQuote(branch)}`);
  return parts.join(' && ');
}

function shellQuote(s: string): string {
  // Conservative single-quote escape — good enough for path / branch names.
  if (/^[A-Za-z0-9_\-./@:+]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}

interface ImBackButtonProps {
  payload: Record<string, unknown>;
  onClick: () => void;
  disabled?: boolean;
}

export function ImBackButton({ payload, onClick, disabled }: ImBackButtonProps) {
  const { t } = useT();
  const snippet = buildRestoreSnippet(payload);
  const [copied, setCopied] = useState(false);
  /* v8 ignore start — the clipboard write is exercised by deploy smoke and
     a jsdom test below stubs navigator.clipboard.  The browser-only call
     here is split out so unit tests can fire onClick without touching
     clipboard at all. */
  async function handleClick() {
    if (snippet && typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(snippet);
        setCopied(true);
      } catch {
        /* Clipboard permission denied — still fire the bump. */
      }
    }
    onClick();
  }
  /* v8 ignore stop */
  return (
    <div data-testid="im-back">
      <button
        type="button"
        onClick={handleClick}
        disabled={disabled}
        className="w-full rounded bg-ctx-600 hover:bg-ctx-500 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-3 text-base font-semibold text-white"
        data-testid="im-back-button"
      >
        {t('context.imBack')}
      </button>
      {snippet ? (
        <div className="mt-2 text-xs text-slate-500" data-testid="im-back-snippet">
          {copied ? t('context.copied') : t('context.willCopy')}{' '}
          <code className="text-ctx-300 break-all">{snippet}</code>
        </div>
      ) : null}
    </div>
  );
}

// ---------- page component ----------

function DetailPage() {
  const initial = Route.useLoaderData();
  const router = useRouter();
  const { t } = useT();
  const [snap, setSnap] = useState<SnapshotDetail | null>(initial);

  if (!snap) {
    return (
      <div className="max-w-2xl mx-auto p-6 text-slate-400" data-testid="not-found">
        <p>{t('context.notFound')}</p>
        <Link to="/" className="text-ctx-400 hover:underline">{t('context.back')}</Link>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <Link to="/" className="text-xs text-ctx-400 hover:underline">{t('context.allSnapshots')}</Link>
      <DetailHeader snapshot={snap} />
      {snap.notes ? (
        <div className="card p-3 mb-4 text-sm text-slate-200 whitespace-pre-wrap" data-testid="notes">
          {snap.notes}
        </div>
      ) : null}
      <LinkedEntities snapshot={snap} />
      <div className="mb-6">
        <PayloadTable payload={snap.payload} />
      </div>
      <ImBackButton
        payload={snap.payload}
        onClick={() => {
          /* v8 ignore next 6 — deploy smoke covers the round-trip; the
             pure pieces (buildRestoreSnippet) are tested independently. */
          void restoreSnapshot({ data: { id: snap.id } }).then((updated) => {
            if (updated) setSnap(updated);
            router.invalidate();
          });
        }}
      />
      <div className="mt-8 text-xs text-slate-500">
        <button
          type="button"
          className="hover:text-slate-300 underline"
          data-testid="delete"
          onClick={() => {
            /* v8 ignore next 7 — deploy smoke covers the delete round-trip. */
            if (!confirm(t('context.confirmDelete'))) return;
            void deleteSnapshot({ data: { id: snap.id } }).then(() => {
              router.navigate({ to: '/' });
            });
          }}
        >
          {t('context.delete')}
        </button>
      </div>
    </div>
  );
}
