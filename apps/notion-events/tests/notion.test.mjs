import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import * as module from '../workers/api/notion.js';

const use = name => {
  assert.equal(typeof module[name], 'function', `${name} is not implemented`);
  return module[name];
};
const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const ids = { workspace: id('1'), integration: id('2'), subscription: id('3'), page: id('4'), block: id('5'), comment: id('6'), author: id('7'), bot: id('8'), event: id('9'), discussion: id('a'), other: id('b') };
const env = () => ({ NOTION_WORKSPACE_ID: ids.workspace, NOTION_INTEGRATION_ID: ids.integration, NOTION_SUBSCRIPTION_ID: ids.subscription, NOTION_PAGE_IDS: JSON.stringify([ids.page]), NOTION_BOT_USER_ID: ids.bot, NOTION_API_TOKEN: 'synthetic-unit-test-token' });
const event = () => ({ id: ids.event, timestamp: '2026-10-25T12:00:00.000Z', workspace_id: ids.workspace, integration_id: ids.integration, subscription_id: ids.subscription, type: 'comment.created', entity: { type: 'comment', id: ids.comment }, authors: [{ id: ids.author, type: 'person' }], data: { page_id: ids.page, parent: { id: ids.page, type: 'page' } } });
const source = changes => ({ id: ids.event, timestamp: '2026-10-25T12:00:00.000Z', pageId: ids.page, commentId: ids.comment, parent: { id: ids.page, type: 'page' }, authors: [{ id: ids.author, type: 'person' }], workspaceId: ids.workspace, integrationId: ids.integration, subscriptionId: ids.subscription, ...changes });
const comment = changes => ({ object: 'comment', id: ids.comment, parent: { type: 'page_id', page_id: ids.page }, discussion_id: ids.discussion, created_by: { object: 'user', id: ids.author }, created_time: '2026-10-25T12:00:00.000Z', last_edited_time: '2026-10-25T12:01:00.000Z', rich_text: [{ type: 'text', plain_text: 'Hello', text: { content: 'Hello' } }], ...changes });
const response = body => Response.json(body);
const rejects = (operation, code, retryable) => assert.rejects(operation, error => error.code === code && error.retryable === retryable);

test('configuration canonicalizes UUIDs and keeps exact page scope', () => {
  const configured = env();
  configured.NOTION_WORKSPACE_ID = ids.workspace.replaceAll('-', '').toUpperCase();
  configured.NOTION_PAGE_IDS = JSON.stringify([ids.page.replaceAll('-', ''), ids.page.toUpperCase()]);
  assert.deepEqual(use('sourceConfig')(configured), { workspaceId: ids.workspace, integrationId: ids.integration, subscriptionId: ids.subscription, pageIds: [ids.page], botUserId: ids.bot });
});

test('configuration requires every UUID and a nonempty JSON page ID array', () => {
  const configure = use('sourceConfig');
  for (const name of ['NOTION_WORKSPACE_ID', 'NOTION_INTEGRATION_ID', 'NOTION_SUBSCRIPTION_ID', 'NOTION_BOT_USER_ID']) {
    assert.throws(() => configure({ ...env(), [name]: undefined }));
    assert.throws(() => configure({ ...env(), [name]: 'not-a-uuid' }));
  }
  for (const value of ['[]', 'null', '{}', '"page"', 'not-json', JSON.stringify([ids.page, 1]), JSON.stringify(['*'])]) {
    assert.throws(() => configure({ ...env(), NOTION_PAGE_IDS: value }));
  }
});

test('normalization preserves signed IDs, timestamp and all supported author types', () => {
  const payload = event();
  payload.authors = ['person', 'bot', 'agent'].map((type, index) => ({ id: [ids.author, ids.other, ids.discussion][index].replaceAll('-', '').toUpperCase(), type }));
  payload.entity.id = ids.comment.replaceAll('-', '').toUpperCase();
  const normalized = use('normalizeSource')(payload, use('sourceConfig')(env()));
  assert.deepEqual(normalized, source({ authors: [{ id: ids.author, type: 'person' }, { id: ids.other, type: 'bot' }, { id: ids.discussion, type: 'agent' }] }));
  assert.equal(payload.entity.id, ids.comment.replaceAll('-', '').toUpperCase());
});

test('modern webhook shape allows absent parent type and optional discussion ID', () => {
  const payload = event();
  delete payload.data.parent.type;
  payload.data.discussion_id = ids.discussion;
  assert.deepEqual(use('normalizeSource')(payload, use('sourceConfig')(env())), source({ parent: { id: ids.page }, discussionId: ids.discussion }));
});

test('only signed page_id determines scope for block comments', () => {
  const payload = event();
  payload.data.parent = { id: ids.block, type: 'block' };
  const normalize = use('normalizeSource'), config = use('sourceConfig')(env());
  assert.deepEqual(normalize(payload, config).parent, { id: ids.block, type: 'block' });
  payload.data.page_id = ids.other;
  payload.data.parent = { id: ids.page, type: 'block' };
  assert.deepEqual(normalize(payload, config), { skip: 'out_of_scope' });
});

test('unrelated events, mismatched source identities and self authors are skipped', () => {
  const normalize = use('normalizeSource'), config = use('sourceConfig')(env());
  for (const type of ['comment.updated', 'comment.deleted', 'page.created']) assert.deepEqual(normalize({ ...event(), type }, config), { skip: 'event_type' });
  for (const [field, reason] of [['workspace_id', 'workspace_mismatch'], ['integration_id', 'integration_mismatch'], ['subscription_id', 'subscription_mismatch']]) {
    assert.deepEqual(normalize({ ...event(), [field]: ids.other }, config), { skip: reason });
  }
  assert.deepEqual(normalize({ ...event(), authors: [{ id: ids.bot.toUpperCase().replaceAll('-', ''), type: 'bot' }] }, config), { skip: 'self_authored' });
});

test('configured automation authors are excluded across integrations without excluding other bots', () => {
  const configured = { ...env(), NOTION_IGNORED_AUTHOR_IDS: JSON.stringify([ids.other.toUpperCase().replaceAll('-', '')]) };
  const config = use('sourceConfig')(configured);
  const payload = { ...event(), authors: [{ id: ids.other, type: 'agent' }] };
  assert.deepEqual(use('normalizeSource')(payload, config), { skip: 'ignored_author' });
  assert.equal(use('normalizeSource')({ ...payload, authors: [{ id: ids.discussion, type: 'bot' }] }, config).commentId, ids.comment);
  for (const invalid of ['null', '{}', 'not-json', '["invalid"]']) assert.throws(() => use('sourceConfig')({ ...env(), NOTION_IGNORED_AUTHOR_IDS: invalid }));
});

test('retrieved creator also honors configured cross-integration loop exclusions', async () => {
  const configured = { ...env(), NOTION_IGNORED_AUTHOR_IDS: JSON.stringify([ids.other]) };
  assert.deepEqual(await use('hydrateComment')(source(), configured, async () => response(comment({ created_by: { id: ids.other } }))), { skip: 'ignored_author' });
});

test('malformed signed source data fails closed', () => {
  const normalize = use('normalizeSource'), config = use('sourceConfig')(env());
  const mutations = [
    value => { value.id = 'invalid'; }, value => { value.timestamp = 'tomorrow'; },
    value => { value.timestamp = '2026-02-30T12:00:00Z'; }, value => { value.entity.type = 'block'; },
    value => { value.entity.id = 'invalid'; }, value => { delete value.data.page_id; },
    value => { value.data.parent.id = 'invalid'; }, value => { value.data.parent.type = 'database'; },
    value => { value.data.discussion_id = 'invalid'; }, value => { value.authors = []; },
    value => { value.authors[0].type = 'unknown'; }, value => { value.authors[0].id = 'invalid'; },
    value => { value.workspace_id = 'invalid'; }, value => { value.data.parent.id = ids.other; }
  ];
  for (const mutate of mutations) {
    const payload = event(); mutate(payload);
    assert.throws(() => normalize(payload, config), error => error.code === 'invalid_source' && error.retryable === false);
  }
});

test('signature verifies exact raw Unicode bytes and rejects forged or malformed values', async () => {
  const verify = use('verifySourceSignature');
  const bytes = new TextEncoder().encode('{ "text": "한글 🌍", "n": 1 }');
  const token = 'synthetic-verification-token';
  const header = `sha256=${createHmac('sha256', token).update(bytes).digest('hex')}`;
  assert.equal(await verify(bytes, header, token), true);
  assert.equal(await verify(bytes.buffer, header, token), true);
  for (const invalid of [null, '', 'sha256=abcd', 'sha1=' + 'a'.repeat(64), 'sha256=' + '0'.repeat(64), header + ' ', header.replace('sha256=', 'SHA256=')]) assert.equal(await verify(bytes, invalid, token), false);
  assert.equal(await verify(new TextEncoder().encode('{"text":"한글 🌍","n":1}'), header, token), false);
  assert.equal(await verify(bytes, header, 'other-token'), false);
  assert.equal(await verify(bytes, header, ''), false);
});

test('hydration GET is fixed, bounded, authenticated and preserves complete Unicode rich text', async () => {
  const hydrate = use('hydrateComment');
  const text = ('  한글 👩🏽‍💻\n' + 'é'.normalize('NFD')).repeat(14000);
  const value = comment({ rich_text: [{ type: 'text', plain_text: text, text: { content: text }, annotations: { bold: true } }, { type: 'mention', plain_text: '@somebody', mention: { type: 'user', user: { id: ids.author } } }], attachments: [{ file: { url: 'https://example.invalid/file' } }] });
  const before = Date.now();
  const result = await hydrate(source(), env(), async (url, init) => {
    assert.equal(url, `https://api.notion.com/v1/comments/${ids.comment}`);
    assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'manual');
    assert.equal(init.headers.Authorization, 'Bearer synthetic-unit-test-token');
    assert.equal(init.headers['Notion-Version'], '2026-03-11');
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.body, undefined);
    return response(value);
  });
  assert.deepEqual(result.comment, value);
  assert.equal(result.text, text + '@somebody');
  assert.ok(Date.parse(result.observedAt) >= before && Date.parse(result.observedAt) <= Date.now());
});

test('hydration accepts block and modern untyped parents and checks optional discussion', async () => {
  const hydrate = use('hydrateComment');
  const block = comment({ parent: { type: 'block_id', block_id: ids.block } });
  assert.deepEqual((await hydrate(source({ parent: { id: ids.block, type: 'block' }, discussionId: ids.discussion }), env(), async () => response(block))).comment, block);
  assert.equal((await hydrate(source({ parent: { id: ids.block } }), env(), async () => response(block))).text, 'Hello');
  await rejects(() => hydrate(source({ discussionId: ids.other }), env(), async () => response(comment())), 'source_mismatch', false);
});

test('hydration refuses changed ID or parent without trusting stale update content', async () => {
  const hydrate = use('hydrateComment');
  for (const value of [comment({ id: ids.other }), comment({ parent: { type: 'page_id', page_id: ids.other } }), comment({ parent: { type: 'block_id', block_id: ids.page } })]) {
    await rejects(() => hydrate(source(), env(), async () => response(value)), 'source_mismatch', false);
  }
});

test('hydration skips comments actually created by this bot', async () => {
  assert.deepEqual(await use('hydrateComment')(source(), env(), async () => response(comment({ created_by: { object: 'user', id: ids.bot.replaceAll('-', '').toUpperCase() } }))), { skip: 'self_authored' });
});

test('hydration rejects malformed comment schema and JSON', async () => {
  const hydrate = use('hydrateComment');
  for (const value of [null, { results: [comment()], has_more: false }, comment({ object: 'page' }), comment({ rich_text: null }), comment({ rich_text: [{ text: { content: 'fallback forbidden' } }] }), comment({ rich_text: [{ plain_text: 5 }] }), comment({ created_by: {} }), comment({ parent: { type: 'database_id', database_id: ids.page } }), comment({ discussion_id: 'bad' })]) {
    await rejects(() => hydrate(source(), env(), async () => response(value)), 'notion_invalid_comment', false);
  }
  await rejects(() => hydrate(source(), env(), async () => new Response('{bad json')), 'notion_invalid_json', false);
  await rejects(() => hydrate(source(), env(), async () => new Response(new Uint8Array([0xff]))), 'notion_invalid_json', false);
});

test('hydration treats forbidden, missing, auth and redirects as permanent', async () => {
  const hydrate = use('hydrateComment');
  for (const status of [301, 302, 400, 401, 403, 404, 422]) {
    await rejects(() => hydrate(source(), env(), async () => new Response('synthetic upstream secret must not escape', { status })), `notion_http_${status}`, false);
  }
});

test('hydration marks 5xx, network and timeouts retryable', async () => {
  const hydrate = use('hydrateComment');
  for (const status of [500, 502, 503, 504, 529]) await rejects(() => hydrate(source(), env(), async () => new Response('', { status })), `notion_http_${status}`, true);
  await rejects(() => hydrate(source(), env(), async () => { throw new TypeError('network failure'); }), 'notion_network', true);
  for (const name of ['TimeoutError', 'AbortError']) await rejects(() => hydrate(source(), env(), async () => { throw new DOMException('timed out', name); }), 'notion_timeout', true);
});

test('hydration honors numeric and date Retry-After without retrying internally', async () => {
  const hydrate = use('hydrateComment');
  for (const [header, minimum, maximum] of [['2.5', 2500, 2500], [new Date(Date.now() + 60000).toUTCString(), 58000, 61000], ['invalid', 1000, 1000]]) {
    let calls = 0;
    await assert.rejects(() => hydrate(source(), env(), async () => { calls++; return new Response('', { status: 429, headers: { 'Retry-After': header } }); }), error => error.code === 'notion_http_429' && error.retryable === true && error.retryAfterMs >= minimum && error.retryAfterMs <= maximum);
    assert.equal(calls, 1);
  }
});

test('request-blocked rate limits are permanent and overload Retry-After is retained', async () => {
  const hydrate = use('hydrateComment');
  await rejects(() => hydrate(source(), env(), async () => new Response(JSON.stringify({ object: 'error', code: 'rate_limited', status: 429, additional_data: { rate_limit_reason: 'public_api_request_blocked' } }), { status: 429, headers: { 'Retry-After': '60' } })), 'notion_http_429', false);
  await assert.rejects(() => hydrate(source(), env(), async () => new Response('{}', { status: 529, headers: { 'Retry-After': '3' } })), failure => failure.code === 'notion_http_529' && failure.retryable === true && failure.retryAfterMs === 3000);
  await assert.rejects(() => hydrate(source(), env(), async () => new Response('{}', { status: 429, headers: { 'Retry-After': '9'.repeat(308) } })), failure => failure.code === 'notion_http_429' && Number.isFinite(failure.retryAfterMs));
});

test('failed cleanup never changes known HTTP or oversized-body classification', async () => {
  const hydrate = use('hydrateComment');
  const broken = (status, declared = false) => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(declared ? 1 : 8 * 1024 * 1024 + 1)); },
    cancel() { throw new Error('synthetic cancellation failure'); }
  }), { status, headers: declared ? { 'content-length': String(8 * 1024 * 1024 + 1) } : {} });
  await rejects(() => hydrate(source(), env(), async () => broken(403, true)), 'notion_http_403', false);
  await rejects(() => hydrate(source(), env(), async () => broken(200, true)), 'notion_body_too_large', false);
  await rejects(() => hydrate(source(), env(), async () => broken(200)), 'notion_body_too_large', false);
});

test('hydration fails over 8 MiB for declared and streaming responses without truncation', async () => {
  const hydrate = use('hydrateComment');
  await rejects(() => hydrate(source(), env(), async () => new Response('{}', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } })), 'notion_body_too_large', false);
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } });
  await rejects(() => hydrate(source(), env(), async () => new Response(stream)), 'notion_body_too_large', false);
  assert.equal(cancelled, true);
});

test('hydration validates local target and token before any request', async () => {
  const hydrate = use('hydrateComment');
  let calls = 0;
  const fetcher = async () => { calls++; return response(comment()); };
  await rejects(() => hydrate(source({ commentId: '../private' }), env(), fetcher), 'invalid_source', false);
  await rejects(() => hydrate(source(), { ...env(), NOTION_API_TOKEN: '' }, fetcher), 'notion_token_missing', false);
  assert.equal(calls, 0);
});
