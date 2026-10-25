import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

// Unit tests exercise the actual relay and SQLite statements. Runtime behavior is
// separately checked in Miniflare; only the SDK's unused entrypoint base is stubbed.
registerHooks({ resolve(specifier, context, next) {
  return specifier === 'cloudflare:workers' ? { url: 'data:text/javascript,export class WorkerEntrypoint {}', shortCircuit: true } : next(specifier, context);
} });
const { NotionEvents } = await import('../workers/api/relay.js');
const id = number => `${String(number).padStart(8, '0')}-1111-4111-8111-111111111111`;
const env = { OAUTH_OWNER_ID: 'owner', NOTION_WORKSPACE_ID: id(1), NOTION_INTEGRATION_ID: id(2), NOTION_SUBSCRIPTION_ID: id(3), NOTION_BOT_USER_ID: id(4), NOTION_PAGE_IDS: JSON.stringify([id(5)]), NOTION_API_TOKEN: 'synthetic-token' };
const source = { id: id(10), type: 'comment.created', timestamp: '2026-10-25T00:00:00Z', pageId: id(5), commentId: id(11), parent: { id: id(5), type: 'page' }, authors: [{ id: id(6), type: 'person' }], workspaceId: id(1), integrationId: id(2), subscriptionId: id(3) };
const webhook = { id: source.id, timestamp: source.timestamp, type: 'comment.created', entity: { type: 'comment', id: source.commentId }, data: { page_id: source.pageId, parent: source.parent }, authors: source.authors, workspace_id: source.workspaceId, integration_id: source.integrationId, subscription_id: source.subscriptionId };
const eventId = `evt_${source.id}`;
function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const sql = { exec(query, ...parameters) {
    if (!parameters.length && query.includes(';')) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    const rows = statement.all(...parameters.map(value => ArrayBuffer.isView(value) ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value instanceof ArrayBuffer ? Buffer.from(value) : value));
    return { toArray: () => rows };
  } };
  const storage = { sql, async setAlarm() {}, async deleteAlarm() {}, transactionSync(callback) {
    db.exec('BEGIN');
    try { const result = callback(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  } };
  const relay = new NotionEvents({ storage }, env);
  const sub = { id: 'sub_1', name: 'notion.comment.created', owner: 'owner', grantId: 'old-grant', arguments: { page_id: id(5) }, expiresAt: Date.now() + 60000, delivery: { mode: 'webhook', url: 'https://chatgpt.com/events', secret: 'whsec_' + Buffer.alloc(32, 1).toString('base64') } };
  sql.exec('INSERT INTO subscriptions VALUES (?, ?, ?, ?, ?)', sub.id, sub.owner, sub.grantId, sub.expiresAt, JSON.stringify(sub));
  sql.exec('INSERT INTO inbox VALUES (?, ?, ?, ?, NULL, 0, 0, NULL)', eventId, JSON.stringify(webhook), JSON.stringify(source), 'pending');
  const body = JSON.stringify({ eventId, name: sub.name, timestamp: source.timestamp, cursor: null, data: { source_type: source.type, notification_contract: 'metadata-only-v1', notification_only: true, automatic_response_allowed: false, attribution: 'unknown', archive_id: eventId, page_id: source.pageId, comment_id: source.commentId } });
  sql.exec('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, 0, 0, NULL, NULL)', 'delivery_1', sub.id, eventId, body, 'pending');
  return { relay, db, sql, sub, row: relay.one('SELECT * FROM deliveries WHERE id=?', 'delivery_1') };
}
test('grant lookup failure records bounded delivery retry instead of escaping the alarm', async t => {
  const { relay, row } = fixture(t);
  relay.liveGrant = async () => { throw new Error('synthetic KV failure'); };
  await assert.doesNotReject(relay.deliver(row));
  const saved = relay.one('SELECT * FROM deliveries WHERE id=?', row.id);
  assert.equal(saved.state, 'pending');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.error, 'grant_lookup_unavailable');
  assert.ok(saved.nextAttempt > Date.now());
});
test('an old grant rejection cannot delete a newer valid subscription', async t => {
  const { relay, sql, sub, row } = fixture(t);
  let release;
  relay.liveGrant = () => new Promise(resolve => { release = resolve; });
  const delivery = relay.deliver(row);
  sub.grantId = 'new-grant';
  sql.exec('UPDATE subscriptions SET grantId=?,data=? WHERE id=?', sub.grantId, JSON.stringify(sub), sub.id);
  release(false);
  await delivery;
  assert.equal(relay.one('SELECT grantId FROM subscriptions WHERE id=?', sub.id)?.grantId, 'new-grant');
  assert.equal(relay.one('SELECT state FROM deliveries WHERE id=?', row.id).state, 'pending');
});
test('queued callbacks recheck current source identity and cross-integration author exclusions', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error('No outbound request is expected'); };
  for (const change of ['author', 'workspace']) {
    const { relay, sql, row } = fixture(t);
    relay.liveGrant = async () => true;
    relay.env = { ...env, ...(change === 'workspace' ? { NOTION_WORKSPACE_ID: id(99) } : { NOTION_IGNORED_AUTHOR_IDS: JSON.stringify([change === 'author' ? id(6) : id(20)]) }) };
    if (change === 'author') sql.exec('UPDATE inbox SET raw=? WHERE id=?', JSON.stringify({ ...webhook, authors: [{ id: id(6), type: 'bot' }] }), eventId);
    await relay.deliver(row);
    assert.equal(relay.one('SELECT state FROM deliveries WHERE id=?', row.id).state, 'cancelled', change);
  }
  assert.equal(outbound, 0);
});

test('shared-person comments are metadata notifications without assumed authorship', t => {
  const { relay } = fixture(t);
  const body = JSON.parse(relay.eventBody(eventId, source, { comment: { last_edited_time: source.timestamp }, observedAt: source.timestamp, text: 'private instruction text' }));
  assert.equal(body.data.notification_only, true);
  assert.equal(body.data.automatic_response_allowed, false);
  assert.equal(body.data.attribution, 'unknown');
  assert.equal(Object.hasOwn(body.data, 'text'), false);
  assert.equal(body.data.source_type, source.type);
  assert.equal(JSON.parse(relay.eventBody(eventId, { ...source, type: 'comment.updated' }, { comment: {}, observedAt: source.timestamp, text: 'edited' })).name, 'notion.comment.updated');
});

test('post-hoc exact receipts are diagnostic and never rewrite or replay callbacks', async t => {
  const { relay, sql, row } = fixture(t);
  const comment = { object: 'comment', id: source.commentId, last_edited_time: source.timestamp, parent: { type: 'page_id', page_id: source.pageId }, rich_text: [{ type: 'text', plain_text: 'same-person output', text: { content: 'same-person output', link: null } }] };
  const before = row.body;
  const receipt = (await relay.callTool({ name: 'record_posted_comment', arguments: { page_id: source.pageId, comment } })).structuredContent;
  assert.equal(receipt.registered, true);
  assert.equal(receipt.automatic_response_allowed, false);
  const { fingerprintComment } = await import('../workers/api/provenance.js');
  sql.exec('UPDATE inbox SET enriched=? WHERE id=?', JSON.stringify({ fingerprint: await fingerprintComment(comment) }), eventId);
  const evidence = (await relay.callTool({ name: 'inspect_event_provenance', arguments: { event_id: eventId } })).structuredContent;
  assert.equal(evidence.exact_snapshot_receipt_match, true);
  assert.equal(evidence.attribution, 'unknown');
  assert.equal(evidence.automatic_response_allowed, false);
  assert.equal(relay.one('SELECT body FROM deliveries WHERE id=?', row.id).body, before);
  assert.equal(relay.one('SELECT COUNT(*) AS count FROM deliveries').count, 1);
});

test('legacy text-bearing callbacks are retained for review without automatic resend', async t => {
  const { relay, sql, row } = fixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let outbound = 0;
  globalThis.fetch = async () => { outbound++; throw new Error('Legacy payload must not leave the relay'); };
  relay.liveGrant = async () => true;
  sql.exec('UPDATE deliveries SET body=? WHERE id=?', JSON.stringify({ eventId, data: { text: 'legacy unclassified input' } }), row.id);
  const legacy = relay.one('SELECT * FROM deliveries WHERE id=?', row.id);
  await relay.deliver(legacy);
  const saved = relay.one('SELECT * FROM deliveries WHERE id=?', row.id);
  assert.equal(saved.state, 'dead');
  assert.equal(saved.error, 'legacy_payload_requires_review');
  assert.equal(saved.body, legacy.body);
  assert.equal(outbound, 0);
  await assert.rejects(relay.callTool({ name: 'retry_failed', arguments: { kind: 'delivery', id: row.id } }));
});
test('malformed source configuration pauses queued delivery with bounded retry', async t => {
  const { relay, row } = fixture(t);
  relay.liveGrant = async () => true;
  relay.env = { ...env, NOTION_IGNORED_AUTHOR_IDS: 'not-json' };
  await assert.doesNotReject(relay.deliver(row));
  const saved = relay.one('SELECT * FROM deliveries WHERE id=?', row.id);
  assert.equal(saved.state, 'pending');
  assert.equal(saved.attempts, 1);
  assert.equal(saved.error, 'source_configuration_invalid');
  assert.ok(saved.nextAttempt > Date.now());
});
test('unexpected capture failures retain source and a usable failure reason', async t => {
  const { relay } = fixture(t);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => Response.json({ object: 'comment', id: source.commentId, parent: { type: 'page_id', page_id: source.pageId }, created_by: { id: id(6) }, discussion_id: id(7), rich_text: [{ plain_text: 'complete text' }] });
  relay.saveArchive = () => { throw new Error('synthetic storage failure'); };
  await assert.doesNotReject(relay.capture(relay.one('SELECT * FROM inbox WHERE id=?', eventId)));
  const saved = relay.one('SELECT * FROM inbox WHERE id=?', eventId);
  assert.equal(saved.state, 'dead');
  assert.equal(saved.error, 'capture_failed');
  assert.equal(saved.raw, JSON.stringify(webhook));
});
test('archive response budget includes the actual JSON-RPC id', async t => {
  const { relay, sql } = fixture(t);
  sql.exec('UPDATE inbox SET raw=? WHERE id=?', JSON.stringify(webhook) + '\n '.repeat(100000), eventId);
  sql.exec('INSERT INTO receipts VALUES (?, ?, ?)', eventId, 'a'.repeat(64), 'source');
  const responseId = 'i'.repeat(60000);
  const result = await relay.callTool({ name: 'read_event_archive', arguments: { event_id: eventId, part: 'source', limit: 65536 } }, responseId);
  assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: responseId, result })) <= 256 * 1024);
});
test('failure pagination exposes every retained failure and rejects invalid cursors', async t => {
  const { relay, sql } = fixture(t);
  for (let index = 0; index < 25; index++) sql.exec('INSERT INTO deliveries VALUES (?, ?, ?, ?, ?, 8, 0, ?, 403)', `failed_${index}`, 'removed-subscription', eventId, '{}', 'dead', 'callback_http_403');
  let cursor, ids = [];
  do {
    const response = await relay.callTool({ name: 'list_failures', arguments: { kind: 'delivery', ...(cursor ? { cursor } : {}), limit: 10 } });
    const page = response.structuredContent;
    assert.ok(page.failures.length <= 10);
    ids.push(...page.failures.map(failure => failure.id));
    cursor = page.next_cursor;
  } while (cursor);
  assert.deepEqual(ids, Array.from({ length: 25 }, (_, index) => `failed_${index}`));
  await assert.rejects(relay.callTool({ name: 'list_failures', arguments: { kind: 'delivery', cursor: '-1' } }));
  const status = (await relay.callTool({ name: 'integration_status' })).structuredContent;
  assert.ok(status.recent_failures.some(failure => failure.id === 'failed_24'));
});
