import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.chdir(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(import.meta.url);
const manifest = process.env.NOTION_EVENTS_WRANGLER_PACKAGE ?? require.resolve('wrangler/package.json');
const wranglerRequire = createRequire(manifest);
const cli = join(dirname(manifest), wranglerRequire('./package.json').bin.wrangler);
const { Miniflare, convertV4MiniflareOptions } = await import(pathToFileURL(wranglerRequire.resolve('miniflare')).href);
const runtimeOptions = options => convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options;
const directory = await mkdtemp(join(tmpdir(), 'notion-events-check-'));
const origin = 'https://notion-events.example.invalid';
const ownerKey = 'synthetic-notion-owner-key-at-least-thirty-two-characters';
const verificationToken = 'synthetic-notion-verification-token';
const apiToken = 'synthetic-notion-api-token';
const workspace = '11111111-1111-4111-8111-111111111111';
const integration = '22222222-2222-4222-8222-222222222222';
const subscription = '33333333-3333-4333-8333-333333333333';
const bot = '44444444-4444-4444-8444-444444444444';
const page = '55555555-5555-4555-8555-555555555555';
const person = '66666666-6666-4666-8666-666666666666';
const discussion = '77777777-7777-4777-8777-777777777777';
const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const callback = 'https://chatgpt.com/mcp-events/notion-check';
const signingSecret = `whsec_${randomBytes(32).toString('base64')}`;
const receiverSecrets = new Set([signingSecret]);
const source = (number, changes = {}) => ({
  id: uuid(number), timestamp: '2026-10-25T12:00:00.000Z', workspace_id: workspace,
  integration_id: integration, subscription_id: subscription, type: 'comment.created',
  entity: { type: 'comment', id: uuid(number + 10000) }, authors: [{ id: person, type: 'person' }],
  data: { page_id: page, parent: { id: page, type: 'page' } }, ...changes,
});
const comments = new Map();
const notionFailures = new Map();
const notionCalls = [];
const deliveries = [];
let callbackStatus = 200;
let callbackFailures = 0;
let verificationStarted;
let releaseVerification;
let deliveryStarted;
let releaseDelivery;
let rejectVerification = false;
const coverageRequested = process.argv.includes('--coverage');
let mf, profiler, sendInspector, coverageUnavailable;

try {
  execFileSync(process.execPath, [cli, 'deploy', '--config', 'workers/api/wrangler.toml', '--dry-run', '--outdir', directory], {
    stdio: 'pipe', env: { ...process.env, XDG_CONFIG_HOME: directory, WRANGLER_LOG_PATH: join(directory, 'wrangler.log'), WRANGLER_SEND_METRICS: 'false' },
  });
  await writeFile(join(directory, 'check-wrapper.js'), `import worker, { NotionEvents as BaseEvents } from './index.js';
export default worker;
export class NotionEvents extends BaseEvents {
  constructor(ctx,env) { super(ctx,env); this.testContext=ctx; }
  async liveGrant(...args) {
    if(this.testFailGrant) throw Error('synthetic grant lookup unavailable');
    if(this.testHoldGrant) {
      this.testHoldGrant=false; this.testGrantHeld=true;
      return new Promise(resolve=>{this.testReleaseGrant=resolve;this.testGrantTimer=setTimeout(()=>resolve(false),10000);});
    }
    return super.liveGrant(...args);
  }
  saveArchive(...args) {
    if(this.testFailArchive && args[1]==='comment') throw Error('synthetic archive transaction failure');
    return super.saveArchive(...args);
  }
  async fetch(request) {
    const path=new URL(request.url).pathname;
    if(path==='/test/grant-failure/on' || path==='/test/grant-failure/off') {
      this.testFailGrant=path.endsWith('/on'); return Response.json({ok:true});
    }
    if(path==='/test/archive-failure/on' || path==='/test/archive-failure/off') {
      this.testFailArchive=path.endsWith('/on'); return Response.json({ok:true});
    }
    if(path==='/test/grant-gate') { this.testHoldGrant=true; return Response.json({ok:true}); }
    if(path==='/test/grant-held') return Response.json({held:this.testGrantHeld===true});
    if(path==='/test/grant-release') { clearTimeout(this.testGrantTimer);this.testReleaseGrant?.(false);this.testGrantHeld=false;return Response.json({ok:true}); }
    if(path==='/test/failure-ledger') {
      const {eventId}=await request.json();
      for(let n=1;n<=21;n++) this.testContext.storage.sql.exec('INSERT INTO deliveries VALUES(?,?,?,?,?,8,0,?,410)',
        'ledger_'+String(n).padStart(4,'0'),'fixture-ledger',eventId,'{}','dead','callback_http_410');
      return Response.json({ok:true});
    }
    if(path==='/test/state') return Response.json({
      inbox:this.testContext.storage.sql.exec('SELECT * FROM inbox ORDER BY rowid').toArray(),
      deliveries:this.testContext.storage.sql.exec('SELECT * FROM deliveries ORDER BY rowid').toArray(),
      subscriptions:this.testContext.storage.sql.exec('SELECT * FROM subscriptions ORDER BY rowid').toArray(),
      operations:this.testContext.storage.sql.exec('SELECT * FROM operations ORDER BY rowid').toArray(),
      alarm:await this.testContext.storage.getAlarm()
    });
    if(path==='/test/due') {
      this.testContext.storage.sql.exec('UPDATE inbox SET nextAttempt=0 WHERE nextAttempt IS NOT NULL');
      this.testContext.storage.sql.exec('UPDATE deliveries SET nextAttempt=0 WHERE nextAttempt IS NOT NULL');
      try { await super.alarm(); return Response.json({ok:true}); }
      catch(error) { return Response.json({error:error.message},{status:500}); }
    }
    if(path==='/test/alarm') { await super.alarm(); return Response.json({ok:true}); }
    return super.fetch(request);
  }
}`);
  const options = {
    inspectorPort: coverageRequested ? 0 : undefined,
    name: 'notion-events', modulesRoot: directory,
    modules: [{ type: 'ESModule', path: join(directory, 'check-wrapper.js') }, { type: 'ESModule', path: join(directory, 'index.js') }],
    compatibilityDate: '2026-10-01', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
    kvNamespaces: ['OAUTH_KV'], durableObjects: { EVENTS: { className: 'NotionEvents', useSQLite: true } },
    bindings: { PUBLIC_ORIGIN: origin, EVENTS_OBJECT_NAME: 'personal-notion-events', OAUTH_OWNER_ID: 'sample-personal-owner',
      OWNER_LOGIN_KEY: ownerKey, NOTION_VERIFICATION_TOKEN: verificationToken, NOTION_API_TOKEN: apiToken,
      NOTION_WORKSPACE_ID: workspace, NOTION_INTEGRATION_ID: integration, NOTION_SUBSCRIPTION_ID: subscription,
      NOTION_BOT_USER_ID: bot, NOTION_PAGE_IDS: JSON.stringify([page]) },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.origin === 'https://cloudflare-dns.com') {
        assert.equal(url.pathname, '/dns-query');
        assert.equal(url.searchParams.get('name'), new URL(callback).hostname);
        const ipv6 = url.searchParams.get('type') === 'AAAA';
        return Response.json({ Status: 0, Answer: [{ type: ipv6 ? 28 : 1, data: ipv6 ? '2606:4700::1111' : '104.18.32.7' }] });
      }
      if (url.origin === 'https://api.notion.com') {
        assert.equal(request.method, 'GET');
        assert.equal(request.headers.get('authorization'), `Bearer ${apiToken}`);
        assert.equal(request.headers.get('notion-version'), '2026-03-11');
        assert.match(url.pathname, /^\/v1\/comments\/[\da-f-]{36}$/);
        const id = url.pathname.split('/').at(-1);
        notionCalls.push(id);
        const failure = notionFailures.get(id);
        if (failure?.remaining > 0) { failure.remaining--; return new Response('', { status: failure.status, headers: { 'retry-after': '1' } }); }
        return Response.json(comments.get(id) ?? { id, object: 'comment', parent: { type: 'page_id', page_id: page },
          discussion_id: discussion, created_by: { id: person },
          rich_text: [{ type: 'text', plain_text: 'Synthetic comment 한글🙂', text: { content: 'Synthetic comment 한글🙂' } }] });
      }
      assert.equal(request.url, callback, 'All external traffic is intercepted at fixed synthetic destinations');
      const bytes = await request.text();
      const id = request.headers.get('webhook-id');
      const timestamp = request.headers.get('webhook-timestamp');
      const signatures = (request.headers.get('webhook-signature') ?? '').split(' ');
      assert.ok([...receiverSecrets].some(secret => signatures.includes('v1,' + createHmac('sha256', Buffer.from(secret.slice(6), 'base64')).update(`${id}.${timestamp}.${bytes}`).digest('base64'))), 'Receiver validates Standard Webhooks signature over exact bytes');
      assert.ok(request.headers.get('x-mcp-subscription-id'));
      const body = JSON.parse(bytes);
      if (body.type === 'verification') {
        if (verificationStarted) { const started = verificationStarted; verificationStarted = undefined; started(); await new Promise(resolve => { releaseVerification = resolve; }); }
        return Response.json({ challenge: rejectVerification ? 'wrong-challenge' : body.challenge });
      }
      deliveries.push({ body, bytes, id, timestamp });
      if (deliveryStarted) { const started = deliveryStarted; deliveryStarted = undefined; started(); await new Promise(resolve => { releaseDelivery = resolve; }); }
      return new Response('', { status: callbackFailures-- > 0 ? 503 : callbackStatus });
    },
  };
  mf = new Miniflare(runtimeOptions(options));
  const send = (path, init = {}) => mf.dispatchFetch(origin + path, { redirect: 'manual', ...init });
  const rpc = async (token, method, params) => {
    const response = await send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    const raw = await response.text();
    assert.ok(Buffer.byteLength(raw) <= 256 * 1024, 'Every MCP response stays inside its delivery envelope');
    return { status: response.status, data: raw ? JSON.parse(raw) : null };
  };
  const internal = async (path, body) => {
    const namespace = await mf.getDurableObjectNamespace('EVENTS');
    return namespace.get(namespace.idFromName('personal-notion-events')).fetch('https://fixture.invalid' + path,
      body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
  };
  const state = async () => (await internal('/test/state')).json();
  const capture = async value => (await state()).inbox.find(row => JSON.parse(row.source).id === value.id);
  const waitFor = async (predicate, message, milliseconds = 6000) => {
    const deadline = Date.now() + milliseconds;
    while (!await predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(await predicate(), message);
  };
  const waitSignal = async (promise, message) => {
    let timeout;
    try { return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), 8000); })]); }
    finally { clearTimeout(timeout); }
  };
  const sign = raw => 'sha256=' + createHmac('sha256', verificationToken).update(raw).digest('hex');
  const ingress = (value, signature) => {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    return send('/webhooks/notion', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-notion-signature': signature ?? sign(raw) }, body: raw });
  };
  const authenticate = async () => {
    const redirect = 'https://chatgpt.com/oauth/callback';
    let response = await send('/oauth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_name: 'Synthetic Notion <untrusted>', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) });
    assert.equal(response.status, 201);
    const client = await response.json();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const authParams = { client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'notion:events', state: 'synthetic-state', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/mcp' };
    assert.equal((await send('/authorize?' + new URLSearchParams({ ...authParams, scope: 'channel:events' }))).status, 400, 'Notion consent cannot grant Channel Talk access');
    response = await send('/authorize?' + new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect, response_type: 'code', scope: 'notion:events', state: 'synthetic-state', code_challenge: challenge, code_challenge_method: 'S256', resource: origin + '/mcp' }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    const html = await response.text();
    assert.ok(html.includes('&#60;untrusted&#62;'));
    assert.ok(html.includes('notion:events'));
    const handle = html.match(/name="handle" value="([^"]+)"/)[1];
    const cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const approve = (key, browserCookie = cookie) => send('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: browserCookie, Origin: origin },
      body: new URLSearchParams({ handle, decision: 'approve', owner_key: key }) });
    assert.equal((await approve('wrong-key')).status, 401);
    assert.equal((await approve(ownerKey, '')).status, 400);
    response = await approve(ownerKey);
    assert.equal(response.status, 302);
    const location = new URL(response.headers.get('location'));
    assert.equal(location.searchParams.get('state'), 'synthetic-state');
    assert.equal((await approve(ownerKey)).status, 400);
    response = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: location.searchParams.get('code'), client_id: client.client_id, redirect_uri: redirect, code_verifier: verifier, resource: origin + '/mcp' }) });
    assert.equal(response.status, 200, await response.clone().text());
    return { ...await response.json(), client_id: client.client_id };
  };

  if (coverageRequested) {
    try {
      await send('/health');
      const inspectorUrl = await mf.getInspectorURL();
      const targets = await (await fetch(new URL('/json/list', inspectorUrl.href.replace(/^ws:/, 'http:')))).json();
      const target = targets.find(item => item.id.includes('notion-events')) ?? targets[0];
      assert.ok(target?.webSocketDebuggerUrl, 'workerd inspector target exists');
      profiler = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { profiler.addEventListener('open', resolve, { once: true }); profiler.addEventListener('error', reject, { once: true }); });
      let nextId = 0;
      const pending = new Map();
      profiler.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (!message.id || !pending.has(message.id)) return;
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error('workerd coverage unavailable: ' + message.error.message));
        else resolve(message.result);
      });
      sendInspector = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        profiler.send(JSON.stringify({ id, method, params }));
      });
      await sendInspector('Profiler.enable');
      await sendInspector('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
    } catch (error) { coverageUnavailable = error.message; profiler?.close(); profiler = undefined; }
  }

  assert.equal((await mf.dispatchFetch('https://other.example.invalid/health')).status, 421);
  const health = await (await send('/health')).text();
  assert.equal(JSON.parse(health).configured, true);
  for (const value of [ownerKey, verificationToken, apiToken, workspace, integration, subscription, bot, page]) assert.ok(!health.includes(value), 'Health contains no source identities or secrets');
  assert.equal((await rpc(undefined, 'events/list')).status, 401);
  assert.equal((await rpc(ownerKey, 'events/list')).status, 401, 'Owner login key cannot be used as a bearer token');
  assert.equal((await ingress('{malformed', 'sha256=' + '0'.repeat(64))).status, 401, 'Signature is checked before malformed JSON is parsed');
  assert.equal((await ingress('{malformed')).status, 400);
  const badUtf8 = Buffer.from([0xc0, 0xaf]);
  assert.equal((await send('/webhooks/notion', { method: 'POST', headers: { 'x-notion-signature': sign(badUtf8) }, body: badUtf8 })).status, 400, 'Signed invalid UTF-8 cannot be repaired or archived');
  let response = await send('/webhooks/notion', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ verification_token: verificationToken }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { verified: true });
  assert.equal((await send('/webhooks/notion', { method: 'POST', body: JSON.stringify({ verification_token: 'wrong' }) })).status, 401);
  assert.equal((await send('/webhooks/notion', { method: 'POST', body: JSON.stringify({ verification_token: verificationToken, extra: true }) })).status, 401, 'Unsigned verification accepts only the exact one-field handshake');
  assert.equal((await ingress({ verification_token: verificationToken }, 'sha256=' + '0'.repeat(64))).status, 401, 'An explicit invalid signature cannot use the unsigned challenge path');
  const exactBytes = JSON.stringify(source(9999));
  assert.equal((await ingress(JSON.stringify(source(9999), null, 2), sign(exactBytes))).status, 401, 'Formatting changes invalidate the raw signature');
  assert.equal((await ingress('x'.repeat(1024 * 1024 + 1))).status, 413);
  console.log('PASS source authentication, verification challenge, ingress limits and safe health');

  for (const [missing, replacement] of [['OWNER_LOGIN_KEY', ''], ['NOTION_API_TOKEN', ''], ['NOTION_WORKSPACE_ID', ''], ['OWNER_LOGIN_KEY', 'x'.repeat(257)]]) {
    const restricted = new Miniflare(runtimeOptions({ ...options, inspectorPort: undefined,
      bindings: { ...options.bindings, [missing]: replacement } }));
    try {
      const unavailable = await restricted.dispatchFetch(origin + '/health');
      assert.equal(unavailable.status, 503);
      const unavailableBody = await unavailable.text();
      assert.equal(JSON.parse(unavailableBody).configured, false);
      for (const value of [ownerKey, verificationToken, apiToken, workspace, integration, subscription, bot, page]) assert.ok(!unavailableBody.includes(value));
      assert.equal((await restricted.dispatchFetch(origin + '/webhooks/notion', { method: 'POST', body: exactBytes, headers: { 'x-notion-signature': sign(exactBytes) } })).status, 503, `${missing} fails closed`);
    } finally { await restricted.dispose(); }
  }

  assert.equal((await state()).inbox.length, 0, 'Verification tokens and rejected source bodies are never archived');
  console.log('PASS owner SQLite initialization');
  const auth = await authenticate();
  const token = auth.access_token;
  for (const separator of ['  ', '\t']) {
    const bearer = await send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer${separator}${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/list' }) });
    assert.equal(bearer.status, 200, 'SDK-accepted Bearer whitespace remains authorized at the owner boundary');
    const bearerData = await bearer.json();
    assert.ok(bearerData.result?.events?.length > 0, JSON.stringify(bearerData));
  }
  const discover = await rpc(token, 'server/discover');
  assert.ok(discover.data.result.capabilities.events);
  assert.equal((await rpc(token, 'events/list')).data.result.events[0].name, 'notion.comment.created');
  const tool = async (name, args = {}) => {
    const result = await rpc(token, 'tools/call', { name, arguments: args });
    assert.equal(result.status, 200);
    assert.equal(result.data.error, undefined, JSON.stringify(result.data));
    assert.notEqual(result.data.result.isError, true, JSON.stringify(result.data));
    return result.data.result.structuredContent;
  };
  assert.ok(await tool('integration_status'));
  const params = { name: 'notion.comment.created', arguments: { page_id: page }, delivery: { mode: 'webhook', url: callback, secret: signingSecret }, ttlMs: 86400000 };
  for (const invalid of [
    { ...params, arguments: { page_id: uuid(500) } },
    { ...params, cursor: 'replay-is-not-supported' },
    { ...params, delivery: { ...params.delivery, url: 'https://127.0.0.1/callback' } },
    { ...params, ttlMs: 0 },
  ]) assert.ok((await rpc(token, 'events/subscribe', invalid)).data.error, 'Invalid source, replay, callback or TTL is rejected before delivery');
  const subscribed = await rpc(token, 'events/subscribe', params);
  assert.equal(subscribed.data.error, undefined, JSON.stringify(subscribed.data));
  assert.ok(subscribed.data.result.id);
  const stop = { ...params, delivery: { mode: 'webhook', url: callback } };
  console.log('PASS OAuth PKCE, browser-bound one-use consent, discovery and signed subscription verification');

  const event = source(1);
  const raw = JSON.stringify(event, null, 2);
  response = await ingress(raw);
  assert.ok([200, 202].includes(response.status), await response.clone().text());
  await waitFor(async () => Boolean(await capture(event)), 'Accepted source is durably archived');
  const eventId = (await capture(event)).id;
  assert.equal((await capture(event)).raw, raw, 'Archive preserves exact signed UTF-8 source');
  await waitFor(() => deliveries.length === 1, 'Verified comment is delivered');
  assert.equal(deliveries[0].body.eventId, deliveries[0].id);
  assert.ok(deliveries[0].bytes.includes('Synthetic comment 한글🙂'));
  assert.equal(notionCalls.filter(id => id === event.entity.id).length, 1);
  await ingress(raw);
  await internal('/test/alarm');
  assert.equal(notionCalls.filter(id => id === event.entity.id).length, 1, 'Identical duplicate never hydrates twice');
  assert.equal(deliveries.length, 1, 'Identical duplicate never delivers twice');
  const retriedRaw = JSON.stringify({ ...event, attempt_number: 2 }, null, 2);
  assert.ok([200, 202].includes((await ingress(retriedRaw)).status), 'Provider attempt metadata may change without changing event identity');
  assert.equal((await capture(event)).raw, raw, 'New receipt never replaces the first original');
  const retryDigest = createHash('sha256').update(retriedRaw).digest('hex');
  const receipt = await tool('read_event_archive', { event_id: eventId, part: 'source', receipt: retryDigest, limit: 65536 });
  assert.equal(receipt.text, retriedRaw, 'Later raw receipt remains inspectable by its content digest');
  assert.equal((await ingress({ ...event, entity: { ...event.entity, id: uuid(999) } })).status, 409);
  await mf.unsafeEvictDurableObject('notion-events', 'NotionEvents', { name: 'personal-notion-events' });
  assert.equal((await capture(event)).raw, raw);
  console.log('PASS durable original archive, comment hydration, signed delivery, restart and conflicting deduplication');

  const baselineCalls = notionCalls.length, baselineDeliveries = deliveries.length;
  const excluded = [
    source(2, { workspace_id: uuid(900) }), source(3, { integration_id: uuid(901) }), source(4, { subscription_id: uuid(902) }),
    source(5, { data: { page_id: uuid(903), parent: { id: uuid(903), type: 'page' } } }),
    source(6, { authors: [{ id: bot, type: 'bot' }] }), source(7, { type: 'page.created' }),
  ];
  for (const value of excluded) assert.ok([200, 202].includes((await ingress(value)).status));
  await internal('/test/alarm');
  assert.equal(notionCalls.length, baselineCalls, 'Excluded sources never reach Notion');
  assert.equal(deliveries.length, baselineDeliveries, 'Excluded sources never reach callback');
  for (const value of excluded) assert.equal(await capture(value), undefined);
  console.log('PASS fixed workspace, integration, provider subscription, page and bot-author boundaries');

  const transient = source(10);
  notionFailures.set(transient.entity.id, { status: 503, remaining: 1 });
  await ingress(transient);
  await waitFor(async () => (await capture(transient))?.attempts >= 1, 'Transient capture attempt is durably recorded');
  const row = await capture(transient);
  assert.equal(row.state, 'pending');
  assert.ok(row.nextAttempt > Date.now());
  await internal('/test/alarm'); // Settle the failed alarm before deliberately evicting its isolate.
  await mf.unsafeEvictDurableObject('notion-events', 'NotionEvents', { name: 'personal-notion-events' });
  await internal('/test/due');
  await waitFor(() => deliveries.length === baselineDeliveries + 1, 'Capture resumes after eviction');
  assert.ok(notionCalls.filter(id => id === transient.entity.id).length >= 2, 'Failed or interrupted reads may repeat across eviction');
  assert.equal((await capture(transient)).state, 'ready');
  assert.equal((await capture(transient)).raw, JSON.stringify(transient));

  const dead = source(11);
  notionFailures.set(dead.entity.id, { status: 403, remaining: 1 });
  await ingress(dead);
  await waitFor(async () => (await capture(dead))?.state === 'dead', 'Nonretryable capture becomes visible dead letter');
  assert.equal((await capture(dead)).raw, JSON.stringify(dead));
  await internal('/test/due');
  assert.equal(notionCalls.filter(id => id === dead.entity.id).length, 1, 'Dead capture never retries automatically');
  await tool('retry_failed', { kind: 'capture', id: (await capture(dead)).id });
  await internal('/test/due');
  await waitFor(() => deliveries.length === baselineDeliveries + 2, 'Owner can explicitly retry retained capture');
  console.log('PASS transient capture retry, restart recovery, durable dead letters and explicit owner retry');

  callbackFailures = 1;
  const deliveryRetry = source(12);
  const beforeRetry = deliveries.length;
  await ingress(deliveryRetry);
  await waitFor(async () => { const id = (await capture(deliveryRetry))?.id; return (await state()).deliveries.some(item => item.eventId === id && item.attempts >= 1); }, 'Failed callback is durably retained');
  const failedBody = deliveries.at(-1).bytes;
  await internal('/test/due');
  await waitFor(() => deliveries.length === beforeRetry + 2, 'Transient callback is retried');
  assert.equal(deliveries.at(-1).bytes, failedBody, 'Callback retry preserves byte-identical event body');
  assert.equal(deliveries.at(-1).id, deliveries.at(-2).id, 'Callback retry preserves stable event ID');
  callbackStatus = 410;
  const gone = source(13);
  await ingress(gone);
  await waitFor(async () => { const id = (await capture(gone))?.id; return (await state()).deliveries.some(item => item.eventId === id && item.state === 'dead'); }, '410 becomes a retained delivery failure');
  const goneRow = (await state()).deliveries.find(item => item.eventId === deliveries.at(-1).id);
  assert.equal(goneRow.status, 410);
  assert.ok((await state()).subscriptions.some(item => item.id === subscribed.data.result.id), '410 retains the selected subscription');
  const goneAttempts = deliveries.length;
  await internal('/test/due');
  assert.equal(deliveries.length, goneAttempts, '410 is not automatically retried');
  callbackStatus = 200;
  await tool('retry_failed', { kind: 'delivery', id: goneRow.id });
  await internal('/test/due');
  await waitFor(() => deliveries.length === goneAttempts + 1, 'Explicit callback retry can recover retained 410');
  assert.equal(deliveries.at(-1).bytes, goneRow.body);
  console.log('PASS exact callback retry bytes, retained 410 subscription and explicit delivery recovery');

  const grantFailure = source(19), beforeGrantFailure = deliveries.length;
  await internal('/test/grant-failure/on');
  await ingress(grantFailure);
  await internal('/test/due');
  const grantCapture = await capture(grantFailure);
  const grantDelivery = (await state()).deliveries.find(item => item.eventId === grantCapture.id);
  assert.equal(grantDelivery.state, 'pending');
  assert.ok(grantDelivery.attempts >= 1, 'Grant lookup network failure consumes a bounded delivery retry attempt');
  assert.ok(grantDelivery.nextAttempt > Date.now(), 'Grant lookup failure backs off instead of spinning the alarm');
  assert.equal(deliveries.length, beforeGrantFailure, 'Unavailable grant check never calls receiver');
  await internal('/test/grant-failure/off');
  await internal('/test/due');
  await waitFor(() => deliveries.length === beforeGrantFailure + 1, 'Grant lookup recovery resumes retained delivery');
  console.log('PASS grant lookup failure retains delivery with bounded backoff');

  const archiveFailure = source(18), beforeArchiveFailure = deliveries.length;
  await internal('/test/archive-failure/on');
  await ingress(archiveFailure);
  await internal('/test/due');
  const archiveCapture = await capture(archiveFailure);
  assert.equal(archiveCapture.state, 'dead', 'Unknown archive transaction failure becomes a retained capture failure');
  assert.equal(archiveCapture.error, 'capture_failed', 'Unknown errors never become undefined SQLite bindings');
  assert.equal(archiveCapture.raw, JSON.stringify(archiveFailure));
  assert.equal(deliveries.length, beforeArchiveFailure);
  await internal('/test/archive-failure/off');
  await tool('retry_failed', { kind: 'capture', id: archiveCapture.id });
  await internal('/test/due');
  await waitFor(() => deliveries.length === beforeArchiveFailure + 1, 'Explicit retry recovers source after archive storage failure');
  console.log('PASS unknown capture failure preserves original source and explicit recovery');

  const huge = source(20, { extra: '한글🙂'.repeat(20000) });
  const hugeText = 'Original 한글🙂\n'.repeat(40000);
  comments.set(huge.entity.id, { id: huge.entity.id, object: 'comment', parent: { type: 'page_id', page_id: page }, discussion_id: discussion,
    created_by: { id: person }, rich_text: [{ type: 'text', plain_text: hugeText, text: { content: hugeText } }] });
  const hugeRaw = JSON.stringify(huge, null, 2), beforeHuge = deliveries.length;
  await ingress(hugeRaw);
  await waitFor(() => deliveries.length === beforeHuge + 1, 'Large comment delivers bounded notification');
  assert.ok(Buffer.byteLength(deliveries.at(-1).bytes) <= 256 * 1024);
  assert.equal(deliveries.at(-1).body.data.text_in_archive, true);
  assert.equal(deliveries.at(-1).body.data.text, undefined, 'Large text is recoverable from archive, never silently prefixed');
  const hugeId = deliveries.at(-1).body.data.archive_id;
  const archive = async part => {
    let text = '', cursor, total;
    for (let count = 0; count < 1000; count++) {
      const result = await tool('read_event_archive', { event_id: hugeId, part, ...(cursor === undefined ? {} : { cursor }), limit: 65536 });
      assert.equal(result.encoding, 'utf-8');
      assert.equal(result.cursor, cursor ?? '0');
      assert.equal(result.event_id, hugeId);
      assert.equal(result.part, part);
      assert.ok(Buffer.byteLength(result.text) <= 65536);
      assert.ok(!result.text.includes('\uFFFD'), 'UTF-8 pages never split a character');
      total = result.total_bytes;
      text += result.text;
      if (result.next_cursor === null || result.next_cursor === undefined) { assert.equal(Buffer.byteLength(text), total); return text; }
      assert.equal(Number(result.next_cursor), Buffer.byteLength(text), 'Archive cursor advances by exact bytes');
      cursor = result.next_cursor;
    }
    throw new Error('Archive pagination did not terminate');
  };
  assert.equal(await archive('source'), hugeRaw);
  const fullComment = JSON.parse(await archive('comment'));
  assert.equal(fullComment.text, hugeText);
  assert.equal(fullComment.comment.rich_text[0].plain_text, hugeText);
  console.log('PASS bounded notification and lossless multi-page UTF-8 source/comment archive recovery');

  const quoteHeavy = source(25);
  const escapedRaw = JSON.stringify(quoteHeavy) + '\n '.repeat(100000);
  const beforeQuotes = deliveries.length;
  await ingress(escapedRaw);
  await waitFor(() => deliveries.length === beforeQuotes + 1, 'Quote-heavy source is captured and delivered');
  const longRequestId = 'q'.repeat(60000);
  const quotedResponse = await send('/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: longRequestId, method: 'tools/call', params: { name: 'read_event_archive',
      arguments: { event_id: (await capture(quoteHeavy)).id, part: 'source', limit: 65536 } } }) });
  assert.equal(quotedResponse.status, 200);
  const quotedBody = await quotedResponse.text();
  assert.ok(Buffer.byteLength(quotedBody) <= 256 * 1024, 'Archive pagination budgets the actual long RPC id and JSON escaping');
  const quotedResult = JSON.parse(quotedBody);
  assert.equal(quotedResult.id, longRequestId);
  assert.ok(quotedResult.result.structuredContent.text.length > 0);
  assert.ok(quotedResult.result.structuredContent.next_cursor);
  console.log('PASS full JSON-RPC response budget with long request IDs and escaped archive text');

  const refreshedAuth = await authenticate();
  const staleGrant = source(26), beforeStaleGrant = deliveries.length;
  await internal('/test/grant-gate');
  await ingress(staleGrant);
  await waitFor(async () => (await (await internal('/test/grant-held')).json()).held, 'Old grant lookup is held while a replacement grant is authorized');
  const refreshed = await rpc(refreshedAuth.access_token, 'events/subscribe', params);
  assert.equal(refreshed.data.result.id, subscribed.data.result.id);
  await internal('/test/grant-release');
  await internal('/test/due');
  assert.ok((await state()).subscriptions.some(item => item.id === refreshed.data.result.id), 'A stale revoked grant result cannot delete a newer authorized subscription');
  await waitFor(() => deliveries.length === beforeStaleGrant + 1, 'New grant resumes pending delivery after stale grant result');
  await rpc(token, 'events/subscribe', params);
  console.log('PASS stale grant result cannot invalidate a subscription refreshed by another live grant');

  await internal('/test/failure-ledger', { eventId });
  const firstFailures = await tool('list_failures', { kind: 'delivery', limit: 20 });
  assert.equal(firstFailures.failures.length, 20);
  assert.ok(firstFailures.next_cursor);
  const lastFailures = await tool('list_failures', { kind: 'delivery', limit: 20, cursor: firstFailures.next_cursor });
  assert.equal(lastFailures.failures.length, 1);
  assert.equal(lastFailures.next_cursor, null);
  assert.deepEqual([...firstFailures.failures, ...lastFailures.failures].map(item => item.id), Array.from({ length: 21 }, (_, index) => `ledger_${String(index + 1).padStart(4, '0')}`));
  for (const failure of [...firstFailures.failures, ...lastFailures.failures]) {
    assert.equal(failure.event_id, eventId);
  }
  for (const args of [{ kind: 'delivery', cursor: 'bad' }, { kind: 'delivery', cursor: '9007199254740992' }, { kind: 'capture', limit: 51 }]) {
    assert.ok((await rpc(token, 'tools/call', { name: 'list_failures', arguments: args })).data.error);
  }
  console.log('PASS complete failure ledger pagination beyond twenty retained failures');

  rejectVerification = true;
  assert.ok((await rpc(token, 'events/subscribe', params)).data.error);
  rejectVerification = false;
  const stopResult = await rpc(token, 'events/unsubscribe', stop);
  assert.deepEqual(stopResult.data.result, {});
  assert.deepEqual((await rpc(token, 'events/unsubscribe', stop)).data.result, {});
  const verifyWait = new Promise(resolve => { verificationStarted = resolve; });
  const verifying = rpc(token, 'events/subscribe', params);
  await waitSignal(verifyWait, 'Subscription challenge did not reach the synthetic receiver');
  await rpc(token, 'events/unsubscribe', stop);
  releaseVerification();
  assert.ok((await verifying).data.error, 'Unsubscribe cancels an in-flight subscription challenge');
  const stoppedCount = deliveries.length;
  await ingress(source(30));
  await internal('/test/due');
  assert.equal(deliveries.length, stoppedCount, 'Unsubscribed callbacks remain stopped');
  const otherAuth = await authenticate();
  const revokeVerifyWait = new Promise(resolve => { verificationStarted = resolve; });
  const revokedVerification = rpc(otherAuth.access_token, 'events/subscribe', params);
  await waitSignal(revokeVerifyWait, 'Revocation challenge did not reach the synthetic receiver');
  assert.equal((await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: otherAuth.refresh_token, token_type_hint: 'refresh_token', client_id: otherAuth.client_id }) })).status, 200);
  releaseVerification();
  assert.ok((await revokedVerification).data.error, 'Grant revocation cancels an in-flight subscription challenge');
  assert.equal((await state()).subscriptions.length, 0, 'A delayed challenge cannot recreate a revoked subscription');
  await rpc(token, 'events/subscribe', params);
  const deliveryWait = new Promise(resolve => { deliveryStarted = resolve; });
  await Promise.all([ingress(source(31)), ingress(source(32)), ingress(source(33))]);
  await waitSignal(deliveryWait, 'Queued delivery did not reach the synthetic receiver');
  const revoked = await send('/oauth/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: auth.refresh_token, token_type_hint: 'refresh_token', client_id: auth.client_id }) });
  assert.equal(revoked.status, 200);
  assert.equal((await rpc(token, 'events/list')).status, 401);
  assert.equal((await rpc(token, 'tools/call', { name: 'read_event_archive', arguments: { event_id: eventId, part: 'source' } })).status, 401);
  releaseDelivery();
  await internal('/test/due');
  assert.equal(deliveries.length, stoppedCount + 1, 'Revocation permits only the callback already in flight');
  console.log('PASS rejected challenge, idempotent unsubscribe, challenge cancellation and queued grant revocation');

  if (coverageRequested && !coverageUnavailable) {
    const profile = await sendInspector('Profiler.takePreciseCoverage');
    const bundle = await readFile(join(directory, 'index.js'), 'utf8');
    const start = bundle.indexOf('// workers/api/');
    assert.ok(start >= 0);
    const functions = profile.result.filter(script => script.url.endsWith('index.js')).flatMap(script => script.functions).filter(fn => fn.ranges[0].startOffset >= start);
    assert.ok(functions.length > 0, 'Actual Worker functions appear in workerd coverage');
    console.log(`PASS actual workerd bundle function coverage ${functions.filter(fn => fn.ranges[0].count > 0).length}/${functions.length}; not a line-coverage claim`);
    await sendInspector('Profiler.stopPreciseCoverage');
  }
  if (coverageUnavailable) { console.error(coverageUnavailable); process.exitCode = 2; }
} finally {
  releaseVerification?.();
  releaseDelivery?.();
  profiler?.close();
  await mf?.dispose();
  await rm(directory, { recursive: true, force: true });
}
