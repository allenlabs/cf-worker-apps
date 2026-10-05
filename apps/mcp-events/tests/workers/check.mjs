import assert from 'node:assert/strict';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const wranglerManifest = require.resolve('wrangler/package.json');
const wranglerRequire = createRequire(wranglerManifest);
const wranglerCli = join(dirname(wranglerManifest), wranglerRequire('./package.json').bin.wrangler);
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);

const origin = 'https://events.example.invalid';
const directory = await mkdtemp(join(tmpdir(), 'mcp-events-check-'));
execFileSync(process.execPath, [wranglerCli, 'deploy', '--config', 'workers/api/wrangler.toml', '--dry-run', '--outdir', directory], { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
await writeFile(join(directory, 'check-wrapper.js'), `import worker, { ThreadHistory as BaseHistory, ChannelEvents } from './index.js';
export default worker;
export { ChannelEvents };
export class ThreadHistory extends BaseHistory {
  async fetch(request) {
    if (new URL(request.url).pathname === '/test/alarm') return Response.json({ alarm: await this.context.storage.getAlarm() });
    if (new URL(request.url).pathname === '/test/observed-at') {
      const { timestamp, messageId } = await request.json();
      this.sql.exec('UPDATE messages SET observedAt = ? WHERE messageId = ?', timestamp, messageId);
      return Response.json({ updated: true });
    }
    return super.fetch(request);
  }
}`);
const deliveries = [];
let callbackStatus = 200;
let heldDelivery;
let releaseDelivery;
let heldVerification;
let releaseVerification;
let rejectedChallenges = false;
let transientFailures = 0;
let signingSecret = `whsec_${randomBytes(32).toString('base64')}`;
const receiverSecrets = new Set([signingSecret]);
const callback = 'https://chatgpt.com/mcp-events/check';
const coverageRequested = process.argv.includes('--coverage');
const workerOptions = {
  inspectorPort: coverageRequested ? 0 : undefined,
  name: 'mcp-events',
  modules: [{ type: 'ESModule', path: join(directory, 'check-wrapper.js') }, { type: 'ESModule', path: join(directory, 'index.js') }], modulesRoot: directory,
  compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
  kvNamespaces: ['OAUTH_KV'], durableObjects: { EVENTS: { className: 'ChannelEvents', useSQLite: true }, THREADS: { className: 'ThreadHistory', useSQLite: true } },
  bindings: { PUBLIC_ORIGIN: origin, EVENTS_OBJECT_NAME: 'sample-channel-events', OAUTH_OWNER_ID: 'sample-owner', SERVER_NAME: 'sample-mcp-events', PRODUCT_NAME: 'Sample Channel Talk', OWNER_LOGIN_KEY: 'owner-test-key-at-least-thirty-two-characters', CHANNEL_APP_SIGNING_KEY: 'ab'.repeat(32), ALLOWED_CHANNEL_ID: '', ALLOWED_CHAT_ID: 'sample-group', CHANNEL_SLUG: 'sample-channel', CHANNEL_APP_ID: 'sample-app' },
  outboundService: async request => {
    const bytes = await request.text();
    const id = request.headers.get('webhook-id');
    const timestamp = request.headers.get('webhook-timestamp');
    const signatures = request.headers.get('webhook-signature').split(' ');
    assert.ok([...receiverSecrets].some(secret => signatures.includes('v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${bytes}`).digest('base64'))));
    assert.ok(request.headers.get('x-mcp-subscription-id'));
    assert.equal(request.url, callback);
    const body = JSON.parse(bytes);
    if (body.type === 'verification') {
      if (heldVerification) { heldVerification(); await new Promise(resolve => { releaseVerification = resolve; }); }
      return Response.json({ challenge: rejectedChallenges ? 'wrong-challenge' : body.challenge });
    }
    assert.equal(id, body.eventId);
    deliveries.push({ body, bytes, timestamp, signatureCount: request.headers.get('webhook-signature').split(' ').length });
    if (heldDelivery) { const signal = heldDelivery; heldDelivery = undefined; signal(); await new Promise(resolve => { releaseDelivery = resolve; }); }
    if (transientFailures-- > 0) return new Response('', { status: 503 });
    return new Response('', { status: callbackStatus });
  }
};
const options = convertV4MiniflareOptions(workerOptions);
const mf = new Miniflare(options);
const send = (path, init) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...init });
const rpc = async (token, method, params) => {
  const response = await send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return { status: response.status, data: await response.json() };
};
const waitFor = async (predicate, message, milliseconds = 6000) => {
  const deadline = Date.now() + milliseconds;
  while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(predicate(), message);
};
let profiler;
let sendInspector;
let coverageUnavailable;
if (coverageRequested) {
  try {
    await send('/health');
    const inspectorUrl = await mf.getInspectorURL();
    const targets = await (await fetch(new URL('/json/list', inspectorUrl.href.replace(/^ws:/, 'http:')))).json();
    const target = targets.find(item => item.id.includes('mcp-events')) ?? targets[0];
    assert.ok(target?.webSocketDebuggerUrl, 'workerd inspector target exists');
    profiler = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { profiler.addEventListener('open', resolve, { once: true }); profiler.addEventListener('error', reject, { once: true }); });
    let nextId = 0;
    const pending = new Map();
    profiler.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error('workerd coverage unavailable: ' + message.error.message));
        else resolve(message.result);
      }
    });
    sendInspector = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      profiler.send(JSON.stringify({ id, method, params }));
    });
    await sendInspector('Profiler.enable');
    await sendInspector('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
  } catch (error) {
    coverageUnavailable = error.message;
    profiler?.close();
    profiler = undefined;
  }
}
const authenticate = async () => {
  const redirect = 'https://chatgpt.com/oauth/callback';
  let response = await send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_name: 'ChatGPT check <untrusted>', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
  assert.equal(response.status, 201);
  const client = await response.json();
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  response = await send('/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'channel:events', state: 'check-state', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/mcp' }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  const html = await response.text();
  assert.ok(html.includes('chatgpt.com'));
  assert.ok(html.includes('Connect Sample Channel Talk'), 'Consent uses the configured product label');
  assert.ok(html.includes('&#60;untrusted&#62;'));
  const handle = html.match(/name="handle" value="([^"]+)"/)[1];
  const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const approve = (key, browserCookie = cookie) => send('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: browserCookie, Origin: origin }, body: new URLSearchParams({ handle, decision: 'approve', owner_key: key }) });
  assert.equal((await approve('wrong-key')).status, 401);
  assert.equal((await approve('owner-test-key-at-least-thirty-two-characters', '')).status, 400, 'Consent cannot be approved from another browser');
  response = await approve('owner-test-key-at-least-thirty-two-characters');
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get('location'));
  assert.equal(location.searchParams.get('state'), 'check-state');
  assert.equal((await approve('owner-test-key-at-least-thirty-two-characters')).status, 400, 'Consent handles are one-use');
  response = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier, resource: origin + '/mcp' }) });
  assert.equal(response.status, 200, await response.clone().text());
  return { ...await response.json(), client_id: client.client_id };
};
const payload = (id, changes = {}) => ({
  method: changes.chatType === 'userChat' ? 'hooks.userChatOpened' : 'hooks.teamChatMessageCreated', systemVersion: 'v1', context: {},
  params: { eventId: id, channelId: changes.channelId ?? 'sample-channel', groupId: changes.chatId ?? 'sample-group', messageId: `message-${id}`, occurredAt: new Date().toISOString(), ...(changes.sourceAppId ? { sourceAppId: changes.sourceAppId } : {}), snapshot: { personType: changes.personType ?? 'manager', personId: 'staff1', plainText: 'Staff message', rootMessageId: 'root-message' } }
});
const signedRequest = (body, signature = createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(body).digest('base64'), path = '/functions/v1') => send(path, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-signature': signature }, body });
const ingress = data => signedRequest(JSON.stringify(data));
const params = { name: 'channel.message.created', arguments: { chat_id: 'sample-group', chat_type: 'group' }, delivery: { mode: 'webhook', url: callback, secret: signingSecret }, ttlMs: 86400000 };
try {
  assert.equal((await mf.dispatchFetch('https://other.example.invalid/health')).status, 421, 'Unexpected hosts cannot become the OAuth issuer');
  const metadataResponse = await send('/.well-known/oauth-protected-resource/mcp');
  assert.equal(metadataResponse.status, 200);
  const resourceMetadata = await metadataResponse.json();
  assert.equal(resourceMetadata.resource, origin + '/mcp');
  assert.deepEqual(resourceMetadata.authorization_servers, [origin]);
  assert.equal((await send('/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list' }) })).status, 401, 'MCP is never anonymously accessible');
  assert.equal((await send('/functions/v1', { method: 'PUT', body: '{bad-json' })).status, 401, 'Native ingress authenticates before parsing');
  const compact = '{"method":"hello","params":{"name":"world"}}';
  const spaced = '{ "method" : "hello" , "params" : { "name" : "world" } }';
  assert.equal((await signedRequest(compact, 'CEqczT1GA1SQjMn+Ae9nBrxAFSexxoJvzv3XphRQntw=')).status, 400, 'Known raw-byte signature authenticates before envelope validation');
  assert.equal((await signedRequest(spaced, 'QnHqccE9CAsl8QFNxCybWpInhepGyfY7kTv/61F44l4=')).status, 400);
  assert.equal((await signedRequest(spaced, 'CEqczT1GA1SQjMn+Ae9nBrxAFSexxoJvzv3XphRQntw=')).status, 401, 'Whitespace changes invalidate signatures');
  assert.equal((await signedRequest(compact, 'v1,CEqczT1GA1SQjMn+Ae9nBrxAFSexxoJvzv3XphRQntw=')).status, 401);
  const discovery = { method: 'extension.core.function.getFunctions', params: {}, context: {}, systemVersion: 'v1' };
  const functions = (await (await ingress(discovery)).json()).result;
  assert.equal(functions.success, true);
  assert.deepEqual(functions.functions.map(item => item.name), ['extension.command.metadata.getCommands', 'commands.ai.open', 'commands.ai.execute', 'commands.ai.status', 'extension.hook.metadata.getHooks', 'hooks.teamChatMessageCreated']);
  assert.deepEqual((await (await signedRequest(JSON.stringify({ ...discovery, method: 'extension.hook.metadata.getHooks' }), undefined, '/functions')).json()).result.hooks, [{ type: 'teamChat.messageCreated', actionFunctionName: 'hooks.teamChatMessageCreated', systemVersion: 'v1' }]);
  assert.equal((await rpc('owner-test-key-at-least-thirty-two-characters', 'events/list')).status, 401, 'Owner login key is not an MCP bearer token');
  for (const missing of ['CHANNEL_APP_SIGNING_KEY', 'ALLOWED_CHAT_ID', 'PUBLIC_ORIGIN', 'EVENTS_OBJECT_NAME', 'OAUTH_OWNER_ID', 'CHANNEL_SLUG', 'CHANNEL_APP_ID']) {
    const restricted = new Miniflare(convertV4MiniflareOptions({ ...workerOptions, inspectorPort: undefined, bindings: { ...workerOptions.bindings, [missing]: '' } }));
    try {
      const data = JSON.stringify(payload('missing-config'));
      const signature = createHmac('sha256', Buffer.from('ab'.repeat(32), 'hex')).update(data).digest('base64');
      assert.equal((await restricted.dispatchFetch(origin + '/functions/v1', { method: 'PUT', headers: { 'x-signature': signature }, body: data })).status, 503, `${missing} fails closed`);
    } finally { await restricted.dispose(); }
  }
  const auth = await authenticate();
  const token = auth.access_token;
  let result = await rpc(token, 'server/discover');
  assert.ok(result.data.result.capabilities.events);
  assert.equal(result.data.result.serverInfo.name, 'sample-mcp-events', 'Discovery uses the configured server label');
  assert.deepEqual(result.data.result.supportedVersions, ['2026-07-28']);
  assert.equal((await rpc(token, 'events/list')).data.result.events.length, 1);
  result = await rpc(token, 'tools/call', { name: 'integration_status', arguments: {} });
  assert.equal(result.data.result.structuredContent.channel_id, null);
  for (const changes of [{ chatType: 'userChat' }, { chatId: 'other-group' }, { sourceAppId: 'sample-app' }]) {
    assert.equal((await ingress(payload('excluded-first', changes))).status, 200);
    assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.channel_id, null, 'Excluded source cannot pin the channel');
  }
  const empty = payload('empty'); empty.params.snapshot = { personType: 'manager' };
  assert.equal((await (await ingress(empty)).json()).result.hookHandlingResult, 'succeeded');
  assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.channel_id, 'sample-channel');
  const mismatch = payload('context-mismatch'); mismatch.context = { channel: { id: 'other-channel' } };
  assert.equal((await (await ingress(mismatch)).json()).result.hookHandlingResult, 'skipped_organization_mismatch');
  assert.equal((await (await ingress(payload('first-source'))).json()).result.hookHandlingResult, 'succeeded');
  assert.equal((await (await ingress(payload('wrong-source', { channelId: 'other-channel' }))).json()).result.hookHandlingResult, 'skipped_organization_mismatch', 'Authenticated later sources cannot change the learned channel');
  assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.channel_id, 'sample-channel');
  console.log('PASS full OAuth, signed native discovery, raw bytes, source exclusion and channel pinning');

  assert.deepEqual((await rpc(token, 'tools/list')).data.result.tools.map(tool => tool.name), ['integration_status', 'get_thread_history']);
  const history = async (threadId, limit) => (await rpc(token, 'tools/call', { name: 'get_thread_history', arguments: { thread_id: threadId, ...(limit === undefined ? {} : { limit }) } })).data;
  const root = payload('history-root'); root.params.messageId = 'sample-root:01'; root.params.snapshot = { personType: 'manager', plainText: 'Root', root: true, threadMsg: false };
  const reply = payload('history-reply'); reply.params.messageId = 'sample-reply:01'; reply.params.snapshot = { personType: 'bot', plainText: 'Reply', rootMessageId: root.params.messageId, threadId: root.params.messageId, root: false, threadMsg: true };
  root.params.occurredAt = new Date(Date.now() - 1000).toISOString();
  reply.params.occurredAt = root.params.occurredAt;
  await ingress(root);
  await Promise.all([ingress(reply), ingress(reply), ingress(reply)]);
  const rootHistory = (await history(root.params.messageId)).result.structuredContent;
  assert.deepEqual(rootHistory.messages.map(message => message.text), ['Root', 'Reply'], 'Equal source timestamps preserve observation order rather than hashed event-ID order');
  assert.equal(rootHistory.observed_only, true);
  assert.equal(rootHistory.historical_backfill, false);
  assert.equal(rootHistory.root_observed, true);
  assert.equal((await history(root.params.messageId, 1)).result.structuredContent.root_observed, true, 'Retained root is recognized even when the response limit omits its text');
  assert.equal(rootHistory.linkage_incomplete, false);
  assert.equal((await history(reply.params.messageId)).result.structuredContent.messages.length, 2, 'Message lookup resolves its retained source thread');
  assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.active_subscriptions, 0, 'History does not create an event subscription');
  const isolated = payload('history-conflict'); isolated.params.snapshot.threadId = 'different-root';
  await ingress(isolated);
  const conflict = (await history(isolated.params.messageId)).result.structuredContent;
  assert.equal(conflict.messages.length, 1);
  assert.equal(conflict.messages[0].thread_mapping, 'conflicting_metadata');
  assert.equal(conflict.linkage_incomplete, true);
  assert.ok(conflict.reference_id.startsWith('isolated/'));
  const unlinked = payload('history-unlinked'); unlinked.params.snapshot = { personType: 'manager', plainText: 'Unknown relationship' };
  await ingress(unlinked);
  assert.equal((await history(unlinked.params.messageId)).result.structuredContent.root_observed, null, 'Missing root metadata does not prove a root message');
  assert.equal((await history(unlinked.params.messageId)).result.structuredContent.linkage_incomplete, true);
  const invalid = payload('history-invalid'); invalid.params.snapshot.rootMessageId = { unexpected: true };
  await ingress(invalid);
  assert.equal((await history(invalid.params.messageId)).result.structuredContent.messages[0].thread_mapping, 'invalid_metadata');
  const unicode = payload('history-bytes'); unicode.params.snapshot = { personType: 'manager', rootMessageId: 'byte-root', plainText: '😀'.repeat(3000) };
  await ingress(unicode);
  const byteHistory = (await history('byte-root')).result.structuredContent;
  assert.equal(Buffer.byteLength(byteHistory.messages[0].text), 8000);
  assert.equal(byteHistory.messages[0].text_truncated, true);
  assert.ok(!byteHistory.messages[0].text.includes('\ufffd'), 'UTF-8 truncation preserves complete characters');
  for (let i = 0; i < 105; i++) {
    const bounded = payload(`history-cap-${i}`); bounded.params.snapshot = { personType: 'manager', rootMessageId: 'bounded-root', plainText: String(i) };
    await ingress(bounded);
  }
  const capped = (await history('bounded-root', 50)).result.structuredContent;
  assert.equal(capped.retained_messages, 100);
  assert.equal(capped.pruned_messages, 5);
  assert.equal(capped.messages.length, 50);
  assert.equal(capped.response_truncated, true);
  const huge = '"'.repeat(8000);
  for (let i = 0; i < 12; i++) {
    const bounded = payload(`history-response-${i}`); bounded.params.snapshot = { personType: 'manager', threadId: 'response-root', plainText: huge };
    await ingress(bounded);
  }
  const responseBound = await history('response-root', 50);
  assert.ok(Buffer.byteLength(JSON.stringify(responseBound)) < 262144, 'MCP text + structured response remains within 256 KiB');
  assert.equal(responseBound.result.structuredContent.response_truncated, true);
  const beforeExcluded = (await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.observed_messages;
  for (const personType of ['user', 'unknown', undefined]) {
    const rejected = payload('history-excluded-' + personType); rejected.params.snapshot = { personType, plainText: 'Exclude' };
    assert.equal((await (await ingress(rejected)).json()).result.hookHandlingResult, 'skipped_ineligible_writer');
  }
  assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.observed_messages, beforeExcluded);
  for (const args of [{}, { thread_id: 'root', limit: 0 }, { thread_id: 'root', limit: 51 }, { thread_id: 'root', channel_id: 'other-channel' }, { thread_id: '../root' }, { thread_id: 'root', limit: '2' }]) assert.equal((await rpc(token, 'tools/call', { name: 'get_thread_history', arguments: args })).data.error.code, -32602);
  assert.equal((await history('not-observed')).error.code, -32004);
  const alarmRoot = payload('history-alarm-root'); alarmRoot.params.messageId = 'alarm-root'; alarmRoot.params.snapshot = { personType: 'manager', root: true, plainText: 'Alarm root' };
  await ingress(alarmRoot);
  const alarmName = JSON.stringify(['sample-channel', 'sample-group', alarmRoot.params.messageId]);
  const threadNamespace = await mf.getDurableObjectNamespace('THREADS');
  const alarmStub = threadNamespace.get(threadNamespace.idFromName(alarmName));
  const oldObservation = Date.now() - 2 * 86400000;
  const setObservedAt = timestamp => alarmStub.fetch('https://history.internal/test/observed-at', { method: 'POST', body: JSON.stringify({ timestamp, messageId: alarmRoot.params.messageId }) });
  await setObservedAt(oldObservation);
  const alarmReply = payload('history-alarm-reply'); alarmReply.params.snapshot.rootMessageId = alarmRoot.params.messageId;
  await ingress(alarmReply);
  const alarmState = await (await alarmStub.fetch('https://history.internal/test/alarm')).json();
  assert.equal(alarmState.alarm, oldObservation + 7 * 86400000, 'New replies preserve the earliest retained message expiry alarm');
  await setObservedAt(Date.now() - 8 * 86400000);
  const expiredHistory = (await history(alarmRoot.params.messageId)).result.structuredContent;
  assert.equal(expiredHistory.messages.length, 1, 'Seven-day-old retained messages expire independently of monitoring');
  assert.equal(expiredHistory.pruned_messages, 1);
  assert.equal(expiredHistory.root_observed, false, 'Expired root is explicitly absent from retained history');
  await mf.unsafeEvictDurableObject('mcp-events', 'ThreadHistory', { name: JSON.stringify(['sample-channel', 'sample-group', root.params.messageId]) });
  assert.equal((await history(root.params.messageId)).result.structuredContent.messages.length, 2, 'Per-thread history survives object restart');
  assert.equal(deliveries.length, 0, 'Monitor-off history never sends callbacks');
  console.log('PASS per-thread history without monitoring, root/reply metadata, unknown/conflicting isolation, deduplication, UTF-8/retention/response limits, lookup validation and durable restart');

  result = await rpc(token, 'events/subscribe', { ...params, arguments: { chat_id: 'sample-group', channel_id: 'other-channel' } });
  assert.equal(result.data.error.code, -32003);
  for (const url of ['http://chatgpt.com/cb', 'https://chatgpt.com.evil.example/cb', 'https://user:password@chatgpt.com/cb', 'https://chatgpt.com:444/cb', 'https://127.0.0.1/cb', 'https://chatgpt.com/cb#fragment']) {
    assert.equal((await rpc(token, 'events/subscribe', { ...params, delivery: { ...params.delivery, url } })).data.error.code, -32602);
  }
  assert.equal((await rpc(token, 'events/subscribe', { ...params, delivery: { ...params.delivery, secret: 'whsec_YQ==' } })).data.error.code, -32602);
  rejectedChallenges = true;
  result = await rpc(token, 'events/subscribe', params);
  assert.equal(result.data.error.code, -32015);
  assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.active_subscriptions, 0);
  rejectedChallenges = false;
  result = await rpc(token, 'events/subscribe', params);
  assert.ok(result.data.result, JSON.stringify(result.data));
  const subscriptionId = result.data.result.id;
  assert.equal(result.data.result.cursor, null);
  assert.ok(Date.parse(result.data.result.refreshBefore) <= Date.now() + params.ttlMs);
  const reordered = { ...params, arguments: { chat_type: 'group', chat_id: 'sample-group' } };
  assert.equal((await rpc(token, 'events/subscribe', reordered)).data.result.id, subscriptionId);
  assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.active_subscriptions, 1);
  console.log('PASS callback boundaries, signed verification, canonical idempotent subscription');

  assert.equal((await ingress(payload('filtered', { chatId: 'other-group' }))).status, 200);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(deliveries.length, 0);
  await ingress(payload('matching'));
  await waitFor(() => deliveries.length === 1, 'Matching event delivered');
  const first = deliveries[0].body;
  assert.equal(first.name, 'channel.message.created');
  assert.equal(first.data.text, 'Staff message');
  assert.equal(first.data.url, 'https://channel.works/sample-channel/team-chat/groups/sample-group');
  assert.equal(first.data.sender_type, 'manager');
  assert.equal(first.data.sender_id, 'staff1');
  assert.equal(first.data.root_message_id, 'root-message');
  assert.equal(first.data.message_id, 'message-matching');
  assert.equal(first.cursor, null);
  await ingress(payload('bot-message', { personType: 'bot' }));
  await waitFor(() => deliveries.length === 2, 'Bot messages in the configured team room are included by default');
  assert.equal(deliveries[1].body.data.sender_type, 'bot');
  const metadata = payload('metadata-only'); metadata.params.snapshot = { personType: 'manager' };
  await ingress(metadata);
  await waitFor(() => deliveries.length === 3, 'Empty snapshots deliver message metadata');
  assert.equal(deliveries[2].body.data.text, '');
  assert.equal(deliveries[2].body.data.message_id, 'message-metadata-only');
  const files = payload('files-only'); files.params.snapshot = { personType: 'manager', files: [{ id: 'file1' }, { id: 'file2' }] };
  await ingress(files);
  await waitFor(() => deliveries.length === 4, 'File-only messages deliver metadata');
  assert.equal(deliveries[3].body.data.text, '');
  assert.equal(deliveries[3].body.data.file_count, 2);
  result = await (await ingress(payload('matching'))).json();
  assert.equal(result.result.hookHandlingResult, 'succeeded');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(deliveries.length, 4, 'Repeated native event ID does not deliver again');
  await mf.unsafeEvictDurableObject('mcp-events', 'ChannelEvents', { name: 'sample-channel-events' });
  await ingress(payload('matching'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(deliveries.length, 4, 'Deduplication survives object restart');
  assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.active_subscriptions, 1);
  transientFailures = 1;
  await ingress(payload('retry'));
  await waitFor(() => deliveries.length === 6, 'Transient failures retry', 6000);
  assert.equal(deliveries[4].body.eventId, deliveries[5].body.eventId);
  assert.equal(deliveries[4].bytes, deliveries[5].bytes, 'Retries preserve exact serialized body');
  assert.ok(Number(deliveries[5].timestamp) >= Number(deliveries[4].timestamp));
  console.log('PASS filters, signed events, durable deduplication/restart and stable retry identity');

  signingSecret = `whsec_${randomBytes(32).toString('base64')}`;
  receiverSecrets.add(signingSecret);
  const rotated = { ...params, delivery: { ...params.delivery, secret: signingSecret } };
  assert.equal((await rpc(token, 'events/subscribe', rotated)).data.result.id, subscriptionId);
  const renewalSecret = `whsec_${randomBytes(32).toString('base64')}`;
  receiverSecrets.add(renewalSecret);
  const renewalStarted = new Promise(resolve => { heldVerification = resolve; });
  const renewal = rpc(token, 'events/subscribe', { ...rotated, delivery: { ...rotated.delivery, secret: renewalSecret } });
  await renewalStarted;
  callbackStatus = 410;
  await ingress(payload('gone'));
  await waitFor(() => deliveries.length === 7, '410 delivery attempted');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(deliveries.length, 7, '410 is not retried');
  assert.equal(deliveries[6].signatureCount, 2, 'Rotation overlaps old and new signing keys');
  heldVerification = undefined;
  releaseVerification();
  assert.equal((await renewal).data.error.code, -32000, '410 prevents in-flight renewal from resurrecting a terminated subscription');
  assert.equal((await rpc(token, 'tools/call', { name: 'integration_status' })).data.result.structuredContent.active_subscriptions, 0);
  await ingress(payload('after-gone'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(deliveries.length, 7, '410 removes the subscription and stops future deliveries');
  await rpc(token, 'events/subscribe', rotated);
  callbackStatus = 413;
  await ingress(payload('large-receiver'));
  await waitFor(() => deliveries.length === 8, '413 delivery attempted');
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(deliveries.length, 8, '413 is not retried');
  callbackStatus = 200;
  const stop = { ...params, delivery: { mode: 'webhook', url: callback } };
  assert.deepEqual((await rpc(token, 'events/unsubscribe', stop)).data.result, {});
  assert.deepEqual((await rpc(token, 'events/unsubscribe', stop)).data.result, {});
  await ingress(payload('after-stop'));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(deliveries.length, 8);
  signingSecret = `whsec_${randomBytes(32).toString('base64')}`;
  receiverSecrets.add(signingSecret);
  rotated.delivery.secret = signingSecret;
  const started = new Promise(resolve => { heldVerification = resolve; });
  const racing = rpc(token, 'events/subscribe', { ...rotated, arguments: { chat_id: 'sample-group' } });
  await started;
  await rpc(token, 'events/unsubscribe', { ...stop, arguments: { chat_id: 'sample-group' } });
  heldVerification = undefined;
  releaseVerification();
  assert.equal((await racing).data.error.code, -32000, 'Unsubscribe prevents delayed verification from reactivating delivery');
  console.log('PASS rotation, nonretryable receiver errors, idempotent unsubscribe and verification cancellation');

  await rpc(token, 'events/subscribe', { ...rotated, ttlMs: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  await ingress(payload('expired'));
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(deliveries.length, 8);
  await rpc(token, 'events/subscribe', rotated);
  const deliveryStarted = new Promise(resolve => { heldDelivery = resolve; });
  await Promise.all([ingress(payload('revoke-race-first')), ingress(payload('revoke-race-second')), ingress(payload('revoke-race-third'))]);
  await deliveryStarted;
  const revoked = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: auth.refresh_token, token_type_hint: 'refresh_token', client_id: auth.client_id }) });
  assert.equal(revoked.status, 200);
  assert.equal((await rpc(token, 'events/list')).status, 401);
  assert.equal((await rpc(token, 'tools/call', { name: 'get_thread_history', arguments: { thread_id: root.params.messageId } })).status, 401, 'Revoked OAuth grant cannot read stored staff history');
  releaseDelivery();
  await ingress(payload('revoked'));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(deliveries.length, 9, 'Grant revocation permits only the callback already in flight, with no later queued delivery');
  assert.equal((await signedRequest('x'.repeat(262145))).status, 413);
  console.log('PASS expiration, OAuth grant revocation and body limits');
  if (coverageRequested && !coverageUnavailable) {
    const profile = await sendInspector('Profiler.takePreciseCoverage');
    const bundle = await readFile(join(directory, 'index.js'), 'utf8');
    const start = bundle.indexOf('// workers/api/index.js');
    assert.ok(start >= 0, 'App source marker exists in bundle');
    const functions = profile.result.filter(script => script.url.endsWith('index.js')).flatMap(script => script.functions).filter(fn => fn.ranges[0].startOffset >= start);
    assert.ok(functions.length > 0, 'Actual application functions appear in workerd coverage');
    const called = functions.filter(fn => fn.ranges[0].count > 0).length;
    await writeFile('../../../mcp-events-coverage.json', JSON.stringify({ worker: 'mcp-events', source: 'workers/api/index.js', functions, called, total: functions.length }, null, 2));
    console.log(`PASS actual workerd application function coverage ${called}/${functions.length} (${(called / functions.length * 100).toFixed(1)}%)`);
    await sendInspector('Profiler.stopPreciseCoverage');
  }
  if (coverageUnavailable) { console.error(coverageUnavailable); process.exitCode = 2; }
} finally { profiler?.close(); await mf.dispose(); await rm(directory, { recursive: true, force: true }); }
