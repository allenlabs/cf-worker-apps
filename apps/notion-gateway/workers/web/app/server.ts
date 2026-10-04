// Web worker entrypoint.  Hono-based — the gateway's "web" face is small
// enough (OAuth start/callback + a thin admin UI) that pulling TanStack
// Start's SSR pipeline in isn't worth the bundle weight.  Same OTel
// wrapper + JWKS-based SSO as PM.

import { Hono, type Context } from 'hono';
import { instrument, type ResolveConfigFn } from '@microlabs/otel-cf-workers';
import { appClients } from '@shared/db/schema';
import { makeDb } from '@shared/db/client';
import {
  callbackOAuthImpl,
  disconnectConnectionImpl,
  disconnectWorkspaceImpl,
  listAdminWorkspacesImpl,
  startOAuthImpl,
  type AdminWorkspaceRow,
} from './server/oauth';
import {
  clearCookieHeader,
  cookieHeader,
  readSessionToken,
  verifySessionToken,
} from './server/session';
import {
  handleWebhookImpl,
  listWebhookAdminImpl,
  updateWebhookUrlImpl,
  type WebhookAdminView,
} from './server/webhook';
import type { Env } from './lib/env';

type Bindings = { Bindings: Env };
const app = new Hono<Bindings>();

// ---------- OAuth start ----------

app.get('/oauth/start', async (c) => {
  const url = new URL(c.req.url);
  const appParam = url.searchParams.get('app');
  const resource = url.searchParams.get('resource');
  const returnTo = url.searchParams.get('return_to');
  const sig = url.searchParams.get('sig');
  if (!appParam || !resource || !returnTo || !sig) {
    return c.text('missing query params', 400);
  }
  const db = makeDb(c.env);
  const result = await startOAuthImpl(db, c.env, {
    app: appParam,
    resource,
    return_to: returnTo,
    sig,
  });
  if (!result.ok) {
    return c.text(result.message, result.status as 400 | 401 | 404);
  }
  return c.redirect(result.redirectUrl, 302);
});

// ---------- OAuth callback ----------

app.get('/oauth/callback', async (c) => {
  const url = new URL(c.req.url);
  const db = makeDb(c.env);
  const result = await callbackOAuthImpl(db, c.env, {
    code: url.searchParams.get('code') ?? undefined,
    state: url.searchParams.get('state') ?? undefined,
    error: url.searchParams.get('error') ?? undefined,
  });
  if (!result.ok) {
    return c.html(
      renderError(`OAuth callback failed: ${escape(result.message)}`),
      result.status as 400 | 404 | 410 | 500,
    );
  }
  return c.redirect(result.redirectUrl, 302);
});

// ---------- SSO gate ----------

type AppContext = Context<Bindings>;

async function requireAdmin(c: AppContext): Promise<boolean> {
  const cookie = c.req.header('cookie') ?? null;
  const token = readSessionToken(cookie);
  if (!token) return false;
  const payload = await verifySessionToken(c.env, token);
  return Boolean(payload);
}

function loginRedirect(c: AppContext): Response {
  // Send the browser to our own /auth/login which knows how to build the
  // right return_to URL for auth.allen.company.  Preserving the originally
  // requested URL in `next` so /auth/callback can bounce back to it after
  // the round-trip.
  const url = new URL(c.req.url);
  const next = url.pathname + url.search;
  return c.redirect(`/auth/login?next=${encodeURIComponent(next)}`, 302);
}

// ---------- SSO entry points ----------

app.get('/auth/login', (c) => {
  const url = new URL(c.req.url);
  const next = url.searchParams.get('next') ?? '/';
  const callback = new URL('/auth/callback', c.env.PUBLIC_BASE_URL);
  if (next && next.startsWith('/')) callback.searchParams.set('next', next);
  const target = new URL('/sign-in', c.env.AUTH_WEB_URL);
  target.searchParams.set('return_to', callback.href);
  return c.redirect(target.href, 302);
});

app.get('/auth/callback', async (c) => {
  const url = new URL(c.req.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next');
  if (!code) return c.redirect('/auth/login', 302);

  const exchangeRes = await fetch(`${c.env.AUTH_API_URL}/sso/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code,
      client_id: new URL(c.env.PUBLIC_BASE_URL).origin,
    }),
  });
  if (exchangeRes.status !== 200) {
    const detail = await exchangeRes.text().catch(() => '');
    return c.text(`Sign-in exchange failed: ${detail.slice(0, 200)}`, 400);
  }
  const { token } = (await exchangeRes.json()) as { token?: string };
  if (!token) return c.text('Sign-in exchange returned no token', 500);

  const payload = await verifySessionToken(c.env, token);
  if (!payload) return c.text('Issued JWT failed local verification', 500);

  const dest = next && next.startsWith('/') ? next : '/';
  return new Response(null, {
    status: 302,
    headers: { location: dest, 'set-cookie': cookieHeader(token) },
  });
});

app.get('/auth/logout', (c) => {
  return new Response(null, {
    status: 302,
    headers: { location: '/', 'set-cookie': clearCookieHeader() },
  });
});

// ---------- Admin landing ----------

app.get('/', async (c) => {
  if (!(await requireAdmin(c))) return loginRedirect(c);
  const db = makeDb(c.env);
  const [rows, webhookAdmin, clients] = await Promise.all([
    listAdminWorkspacesImpl(db),
    listWebhookAdminImpl(db),
    db.select().from(appClients).orderBy(appClients.id),
  ]);
  return c.html(renderHome(c.env.APP_NAME, rows, webhookAdmin, clients));
});

app.get('/workspaces', async (c) => {
  if (!(await requireAdmin(c))) return loginRedirect(c);
  const db = makeDb(c.env);
  const rows = await listAdminWorkspacesImpl(db);
  return c.html(renderWorkspaces(c.env.APP_NAME, rows));
});

app.post('/workspaces/:id/disconnect', async (c) => {
  if (!(await requireAdmin(c))) return loginRedirect(c);
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.text('bad id', 400);
  const db = makeDb(c.env);
  await disconnectWorkspaceImpl(db, id);
  return c.redirect('/workspaces', 302);
});

app.get('/connections', async (c) => {
  if (!(await requireAdmin(c))) return loginRedirect(c);
  const db = makeDb(c.env);
  const rows = await listAdminWorkspacesImpl(db);
  return c.html(renderConnections(c.env.APP_NAME, rows));
});

app.post('/connections/disconnect', async (c) => {
  if (!(await requireAdmin(c))) return loginRedirect(c);
  const body = await c.req.parseBody();
  const appClientId = Number(body.app_client_id);
  const appResource = String(body.app_resource ?? '');
  if (!Number.isFinite(appClientId) || !appResource) {
    return c.text('bad form', 400);
  }
  const db = makeDb(c.env);
  await disconnectConnectionImpl(db, appClientId, appResource);
  return c.redirect('/connections', 302);
});

// ---------- Notion webhook receiver ----------
//
// Unauthenticated by design — Notion can't carry the gateway's SSO
// cookie.  We re-verify every event ourselves via `X-Notion-Signature`.

app.post('/webhooks/notion', async (c) => {
  const rawBody = await c.req.raw.text();
  const sig = c.req.header('x-notion-signature') ?? c.req.header('X-Notion-Signature') ?? null;
  const db = makeDb(c.env);
  const result = await handleWebhookImpl(db, { rawBody, signatureHeader: sig });
  if (result.fanned && result.fanout) {
    c.executionCtx.waitUntil(result.fanout());
  }
  return c.body(result.body, result.status as 200 | 400 | 401);
});

// ---------- App-client webhook URL admin ----------

app.post('/admin/app-clients/:id/webhook-url', async (c) => {
  if (!(await requireAdmin(c))) return loginRedirect(c);
  const id = Number(c.req.param('id'));
  if (!Number.isFinite(id)) return c.text('bad id', 400);
  const body = await c.req.parseBody();
  const url = String(body.webhook_url ?? '').trim();
  const db = makeDb(c.env);
  await updateWebhookUrlImpl(db, id, url || null);
  return c.redirect('/', 302);
});

app.get('/health', (c) => c.json({ ok: true, service: 'notion-gateway-web' }));

// ---------- HTML helpers ----------

function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escape(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 960px; margin: 2em auto; padding: 0 1em; color: #1a1a1a; }
  h1 { font-size: 1.5em; }
  h2 { font-size: 1.2em; margin-top: 1.5em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { padding: 0.5em; border-bottom: 1px solid #e0e0e0; text-align: left; font-size: 0.9em; }
  th { background: #f7f7f7; }
  nav a { margin-right: 1em; }
  form.inline { display: inline; }
  button { font-size: 0.8em; padding: 0.2em 0.6em; cursor: pointer; }
</style>
</head>
<body>
<nav><a href="/">Home</a><a href="/workspaces">Workspaces</a><a href="/connections">Connections</a></nav>
${body}
</body>
</html>`;
}

function renderError(message: string): string {
  return layout('Notion Gateway — error', `<h1>Error</h1><p>${message}</p>`);
}

function renderHome(
  appName: string,
  rows: AdminWorkspaceRow[],
  webhooks: WebhookAdminView,
  clients: Array<{ id: number; clientId: string; name: string; webhookUrl: string | null }>,
): string {
  const connCount = rows.reduce((n, w) => n + w.connections.length, 0);
  const pendingHtml = webhooks.pending.length === 0
    ? '<p>No pending webhook subscriptions.</p>'
    : webhooks.pending
        .map(
          (p) => `<div class="card">
  <p><strong>Pending subscription #${p.id}</strong> (created ${escape(p.createdAt)})</p>
  <p>Paste this token into Notion's webhook form to complete verification:</p>
  <pre><code>${escape(p.verificationToken)}</code></pre>
</div>`,
        )
        .join('');
  const clientsHtml = clients
    .map(
      (cl) => `<tr>
  <td>${escape(cl.clientId)}</td>
  <td>${escape(cl.name)}</td>
  <td>
    <form method="post" action="/admin/app-clients/${cl.id}/webhook-url">
      <input type="url" name="webhook_url" value="${escape(cl.webhookUrl ?? '')}" placeholder="https://app.example/webhooks/notion" size="40" />
      <button type="submit">Save</button>
    </form>
  </td>
</tr>`,
    )
    .join('');
  return layout(`${appName} — admin`, `
<h1>${escape(appName)}</h1>
<p>${rows.length} workspace(s), ${connCount} connection(s) tracked.</p>
<p><a href="/workspaces">View workspaces</a> · <a href="/connections">View connections</a></p>

<h2>Webhook subscriptions</h2>
<p>${webhooks.verifiedCount} verified subscription(s).</p>
${pendingHtml}

<h2>App-client webhook URLs</h2>
<table><thead><tr><th>Client</th><th>Name</th><th>Webhook URL</th></tr></thead><tbody>${clientsHtml}</tbody></table>
`);
}

function renderWorkspaces(appName: string, rows: AdminWorkspaceRow[]): string {
  if (rows.length === 0) {
    return layout(`${appName} — workspaces`, '<h1>Workspaces</h1><p>No workspaces connected yet.</p>');
  }
  const body = rows
    .map(
      (w) => `
<tr>
  <td>${escape(w.name)}</td>
  <td>${escape(w.ownerEmail ?? '')}</td>
  <td>${w.connections.length}</td>
  <td><form class="inline" method="post" action="/workspaces/${w.id}/disconnect"><button type="submit" onclick="return confirm('Disconnect ${escape(w.name)}?')">Disconnect</button></form></td>
</tr>`,
    )
    .join('');
  return layout(`${appName} — workspaces`, `
<h1>Workspaces</h1>
<table><thead><tr><th>Name</th><th>Owner</th><th>Connections</th><th></th></tr></thead><tbody>${body}</tbody></table>
`);
}

function renderConnections(appName: string, rows: AdminWorkspaceRow[]): string {
  const groups = rows
    .filter((w) => w.connections.length > 0)
    .map(
      (w) => `
<h2>${escape(w.name)}</h2>
<table><thead><tr><th>App</th><th>Resource</th><th>Database</th><th>Created</th><th></th></tr></thead><tbody>
${w.connections
  .map(
    (c) => `<tr>
  <td>${escape(c.appClient)}</td>
  <td>${escape(c.appResource)}</td>
  <td>${escape(c.databaseTitle)}</td>
  <td>${escape(c.createdAt)}</td>
  <td></td>
</tr>`,
  )
  .join('')}
</tbody></table>`,
    )
    .join('');
  return layout(`${appName} — connections`, `
<h1>Connections</h1>
${groups || '<p>No connections yet.</p>'}
`);
}

// ---------- Worker export ----------

const worker = {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

const otelConfig: ResolveConfigFn<Env> = (env) => ({
  service: { name: 'notion-gateway-web', version: '0.1.0' },
  exporter: {
    url: 'https://lgtm-otlp.allenlabs.org/v1/traces',
    headers: {
      authorization: `Bearer ${env.OTEL_BEARER_TOKEN}`,
      'cf-access-client-id': env.OTEL_ACCESS_ID,
      'cf-access-client-secret': env.OTEL_ACCESS_SECRET,
    },
  },
});

export default instrument(worker, otelConfig);
