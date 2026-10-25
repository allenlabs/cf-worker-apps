import { OAuthProvider, insufficientScope } from '@cloudflare/workers-oauth-provider';
import { bodyBytes, bodyText, publicOrigin, equal, identifier } from '../../../mcp-events/workers/api/protocol.js';
import { ownerConsent } from '../../../mcp-events/workers/api/oauth.js';
import { sourceConfig, normalizeSource, verifySourceSignature } from './notion.js';
import { SCOPE, oauthOptions } from './auth.js';

export { NotionEvents } from './relay.js';

const SOURCE_LIMIT = 1024 * 1024;
const object = env => env.EVENTS.get(env.EVENTS.idFromName(env.EVENTS_OBJECT_NAME));
const secretPresent = value => typeof value === 'string' && Boolean(value.trim()) && value.isWellFormed();
function configuration(env) {
  if (!publicOrigin(env) || !identifier(env.EVENTS_OBJECT_NAME) || !identifier(env.OAUTH_OWNER_ID) ||
      !env.EVENTS || !env.OAUTH_KV || !secretPresent(env.NOTION_VERIFICATION_TOKEN) || !secretPresent(env.NOTION_API_TOKEN) ||
      !secretPresent(env.OWNER_LOGIN_KEY) || env.OWNER_LOGIN_KEY.length < 32 || env.OWNER_LOGIN_KEY.length > 256) return null;
  try { return sourceConfig(env); } catch { return null; }
}
const rpcError = (id, code, message, status) => Response.json({ jsonrpc: '2.0', id, error: { code, message } }, { status });

const mcpHandler = {
  async fetch(request, env, context) {
    if (!context.auth.scope.includes(SCOPE)) return insufficientScope(context.auth, [SCOPE]);
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    if (new URL(request.url).pathname !== '/mcp') return new Response(null, { status: 404 });
    let input;
    try { input = JSON.parse(await bodyText(request, 65536)); }
    catch (error) { return rpcError(null, -32700, 'Invalid JSON request', error.code === 413 ? 413 : 400); }
    if (!input || Array.isArray(input) || typeof input !== 'object' || input.jsonrpc !== '2.0' || typeof input.method !== 'string' ||
        (input.id != null && !(typeof input.id === 'string' || typeof input.id === 'number' && Number.isFinite(input.id))) ||
        (input.params !== undefined && (input.params === null || typeof input.params !== 'object'))) {
      return rpcError(null, -32600, 'Invalid request', 400);
    }
    try {
      const principal = await env.OAUTH_PROVIDER.unwrapToken(context.auth.token);
      if (!principal || principal.userId !== env.OAUTH_OWNER_ID || principal.grant?.props?.userId !== principal.userId || !identifier(principal.grantId)) {
        return new Response(null, { status: 403 });
      }
      if (input.method === 'notifications/initialized' && !Object.hasOwn(input, 'id')) return new Response(null, { status: 202 });
      return await object(env).fetch('https://events.internal/rpc', {
        method: 'POST', body: JSON.stringify({ input, principal: { owner: principal.userId, grantId: principal.grantId } })
      });
    } catch { return rpcError(input.id ?? null, -32603, 'Internal error', 500); }
  }
};

async function notionWebhook(request, env) {
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  let bytes;
  try { bytes = await bodyBytes(request, SOURCE_LIMIT); }
  catch (error) { return new Response(error.code === 413 ? 'Request body too large' : 'Invalid request body', { status: error.code === 413 ? 413 : 400 }); }
  const signature = request.headers.get('x-notion-signature');
  if (signature !== null && !await verifySourceSignature(bytes, signature, env.NOTION_VERIFICATION_TOKEN)) return new Response('Invalid Notion signature', { status: 401 });
  let raw, input;
  try {
    raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    input = JSON.parse(raw);
  } catch { return new Response(signature === null ? 'Invalid Notion signature' : 'Invalid JSON event', { status: signature === null ? 401 : 400 }); }
  if (signature === null || input && typeof input === 'object' && Object.hasOwn(input, 'verification_token')) {
    if (!input || Array.isArray(input) || Object.keys(input).length !== 1 ||
        typeof input.verification_token !== 'string' || !input.verification_token.isWellFormed() ||
        !await equal(input.verification_token, env.NOTION_VERIFICATION_TOKEN)) return new Response('Invalid verification request', { status: 401 });
    return Response.json({ verified: true });
  }
  let source;
  try { source = normalizeSource(input, sourceConfig(env)); }
  catch { return new Response('Invalid Notion event', { status: 400 }); }
  if (source.skip) return Response.json({ accepted: true, skipped: source.skip }, { status: 202 });
  try {
    const response = await object(env).fetch('https://events.internal/ingest', { method: 'POST', body: JSON.stringify({ raw, source }) });
    if (response.status === 409) return new Response('Conflicting event identifier', { status: 409 });
    if (response.status !== 202) return new Response('Event could not be stored', { status: 503 });
    return Response.json({ accepted: true }, { status: 202 });
  } catch { return new Response('Event could not be stored', { status: 503 }); }
}

const defaultHandler = {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/webhooks/notion') return notionWebhook(request, env);
    if (path === '/authorize') return ownerConsent(request, env, {
      scope: SCOPE, productName: 'Personal Notion Events',
      description: 'This permits created/updated comment metadata notifications, source and comment archive reads, diagnostic write receipts, status and failed-delivery retries for configured pages. Authorship remains unknown. Automatic comment responses are not supported.',
      metadata: {}
    });
    return new Response('Personal Notion Events. Connect /mcp with OAuth.', { status: path === '/' ? 200 : 404 });
  }
};

export default {
  async fetch(request, env, context) {
    const configured = Boolean(configuration(env));
    if (publicOrigin(env) && new URL(request.url).origin !== publicOrigin(env)) return new Response('Unexpected origin', { status: 421 });
    if (new URL(request.url).pathname === '/health' && request.method === 'GET') {
      return Response.json({ ok: configured, provider: 'notion', protocolVersion: '2026-07-28', configured, notification_only: true, automatic_response_allowed: false }, { status: configured ? 200 : 503 });
    }
    if (!configured) return new Response('Service configuration is incomplete', { status: 503 });
    return new OAuthProvider(oauthOptions(env, { apiHandler: mcpHandler, defaultHandler })).fetch(request, env, context);
  }
};
