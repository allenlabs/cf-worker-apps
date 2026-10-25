import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { fingerprintComment as fingerprint, postedReceipt as receipt } from '../workers/api/provenance.js';
const id = digit => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const ids = { page: id('1'), comment: id('2'), other: id('3'), person: id('4'), mentioned: id('5') };
const revision = '2026-10-25T12:00:00.123Z';
const rich = () => [
  { type: 'text', text: { content: 'Hello 한글🙂', link: { url: 'https://example.invalid/first' } },
    plain_text: 'Hello 한글🙂', href: 'https://example.invalid/first', annotations: { bold: false, italic: true, color: 'default' } },
  { type: 'mention', mention: { type: 'user', user: { object: 'user', id: ids.mentioned } }, plain_text: '@Synthetic' },
  { type: 'equation', equation: { expression: 'x^2' }, plain_text: 'x^2' },
];
const comment = (changes = {}) => ({ object: 'comment', id: ids.comment, last_edited_time: revision,
  rich_text: rich(), created_by: { object: 'user', id: ids.person, name: 'Synthetic person' }, ...changes });
const config = () => ({ pageIds: [ids.page] });
const rejected = operation => assert.rejects(operation, error => error.code === -32602 && error.message === 'Exact acknowledged comment snapshot required');
const reverseKeys = value => Array.isArray(value) ? value.map(reverseKeys) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseKeys(child)])) : value;

test('fingerprint canonicalizes the comment UUID and preserves the exact revision', async () => {
  const value = await fingerprint(comment({ id: ids.comment.replaceAll('-', '').toUpperCase() }));
  assert.equal(value.commentId, ids.comment);
  assert.equal(value.revision, revision);
  assert.equal(value.hashVersion, 'notion-rich-text-v1');
  assert.match(value.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(value), ['commentId', 'revision', 'hashVersion', 'contentHash']);
});

test('author identities, names and by-you labels cannot classify identical content', async () => {
  const first = await fingerprint(comment());
  const second = await fingerprint(comment({ created_by: { id: ids.other, name: 'Companion' }, display_name: 'by you', author_type: 'assistant' }));
  assert.deepEqual(second, first);
  assert.deepEqual(await fingerprint(comment({ created_by: { id: ids.person, name: 'A different display name' } })), first);
});

test('distinct comment IDs remain distinct even with the same author, content and revision', async () => {
  const first = await fingerprint(comment());
  const second = await fingerprint(comment({ id: ids.other }));
  assert.equal(first.contentHash, second.contentHash);
  assert.notEqual(first.commentId, second.commentId);
  assert.notDeepEqual(first, second);
});

test('every rich-text formatting, link, mention target and equation change affects the hash', async () => {
  const first = await fingerprint(comment());
  for (const mutate of [
    text => { text[0].text.content += '!'; },
    text => { text[0].plain_text += '!'; },
    text => { text[0].annotations.bold = true; },
    text => { text[0].annotations.color = 'red'; },
    text => { text[0].text.link.url = 'https://example.invalid/second'; },
    text => { text[0].href = 'https://example.invalid/second'; },
    text => { text[1].mention.user.id = ids.other; },
    text => { text[2].equation.expression = 'x^3'; },
    text => { text[0].annotations.future_format = { mode: 'different' }; },
  ]) {
    const value = comment(); mutate(value.rich_text);
    assert.notEqual((await fingerprint(value)).contentHash, first.contentHash);
  }
});

test('JSON object key order is immaterial at every nested level', async () => {
  assert.deepEqual(await fingerprint(reverseKeys(comment())), await fingerprint(comment()));
  const reversed = comment({ rich_text: rich().reverse() });
  assert.notEqual((await fingerprint(reversed)).contentHash, (await fingerprint(comment())).contentHash, 'Array order is content');
});

test('same or restored content at a new edit time remains a different revision', async () => {
  const first = await fingerprint(comment());
  const edited = await fingerprint(comment({ last_edited_time: '2026-10-25T12:00:01.123Z', rich_text: [{ type: 'text', text: { content: 'Changed' } }] }));
  const restored = await fingerprint(comment({ last_edited_time: '2026-10-25T12:00:02.123Z' }));
  assert.notEqual(edited.contentHash, first.contentHash);
  assert.equal(restored.contentHash, first.contentHash);
  assert.notEqual(restored.revision, first.revision);
  const precise = '2026-10-25T12:00:00.123456Z';
  assert.equal((await fingerprint(comment({ last_edited_time: precise }))).revision, precise);
});

test('Unicode content is complete, unnormalized and hashed without shortening', async () => {
  const text = ('  한글 👩🏽‍💻\n' + 'é'.normalize('NFD')).repeat(30000);
  const value = comment({ rich_text: [{ type: 'text', text: { content: text } }] });
  const expected = createHash('sha256').update(JSON.stringify([{ text: { content: text }, type: 'text' }])).digest('hex');
  assert.equal((await fingerprint(value)).contentHash, expected);
  assert.notEqual((await fingerprint(comment({ rich_text: [{ type: 'text', text: { content: text.normalize('NFC') } }] }))).contentHash, expected);
});

test('empty supported text and documented mention forms are preserved', async () => {
  const types = [
    { type: 'text', text: { content: '', link: null }, href: null },
    { type: 'equation', equation: { expression: '' } },
    { type: 'mention', mention: { type: 'page', page: { id: ids.page } } },
    { type: 'mention', mention: { type: 'database', database: { id: ids.other } } },
    { type: 'mention', mention: { type: 'date', date: { start: '2026-10-25', end: null, time_zone: null } } },
    { type: 'mention', mention: { type: 'link_preview', link_preview: { url: 'https://example.invalid/preview' } } },
    { type: 'mention', mention: { type: 'template_mention', template_mention: { type: 'template_mention_user', template_mention_user: 'me' } } },
    { type: 'mention', mention: { type: 'custom_emoji', custom_emoji: { id: ids.other, name: 'Synthetic', url: 'https://example.invalid/emoji' } } },
  ];
  assert.ok(await fingerprint(comment({ rich_text: types })));
  assert.ok(await fingerprint(comment({ rich_text: [] })));
});

test('attachment-bearing or still-uploading snapshots are unsupported', async () => {
  for (const attachments of [[{ type: 'file', file: { url: 'https://example.invalid/ephemeral' } }], null, {}, '']) {
    assert.equal(await fingerprint(comment({ attachments })), null);
  }
  assert.equal(await fingerprint(comment({ attachments: [], has_pending_attachments: true })), null);
  assert.equal(await fingerprint(comment({ has_pending_attachments: 'false' })), null);
  assert.deepEqual(await fingerprint(comment({ attachments: [], has_pending_attachments: false })), await fingerprint(comment()));
});

test('incomplete, unknown or malformed rich-text snapshots return null', async () => {
  for (const rich_text of [null, {}, [null], ['text'], [{ type: 'future', plain_text: 'No fallback' }],
    [{ type: 'text' }], [{ type: 'text', text: { content: 1 } }], [{ type: 'text', text: { content: '\uD800' } }],
    [{ type: 'text', text: { content: 'Valid' }, plain_text: 1 }],
    [{ type: 'text', text: { content: 'Valid', link: { url: 1 } } }],
    [{ type: 'text', text: { content: 'Valid' }, href: false }],
    [{ type: 'text', text: { content: 'Valid' }, annotations: { bold: 'true' } }],
    [{ type: 'mention', mention: { type: 'user', user: {} } }],
    [{ type: 'mention', mention: { type: 'future', future: {} } }],
    [{ type: 'equation', equation: { expression: null } }]]) {
    assert.equal(await fingerprint(comment({ rich_text })), null);
  }
});

test('comment IDs and ISO edit times fail closed without rolling invalid dates forward', async () => {
  for (const value of [undefined, '', 'not-a-uuid', '../comment']) assert.equal(await fingerprint(comment({ id: value })), null);
  for (const value of [undefined, null, 1, 'tomorrow', '2026-10-25', '2026-02-30T12:00:00Z', '2026-10-25T24:00:00Z', '2026-10-25T12:60:00Z', '2026-10-25T12:00:60Z']) {
    assert.equal(await fingerprint(comment({ last_edited_time: value })), null);
  }
  for (const value of [null, [], 'comment', comment({ object: 'page' })]) assert.equal(await fingerprint(value), null);
  assert.ok(await fingerprint(comment({ last_edited_time: '2024-02-29T12:34:56+09:00' })));
});

test('non-JSON values, cycles and malformed Unicode never produce a content hash', async () => {
  for (const value of [undefined, NaN, Infinity, 1n, () => {}, Symbol('unsupported'), new Date(), '\uD800']) {
    const snapshot = comment(); snapshot.rich_text[0].extra = value;
    assert.equal(await fingerprint(snapshot), null);
  }
  const cyclic = comment(); cyclic.rich_text[0].extra = cyclic.rich_text;
  assert.equal(await fingerprint(cyclic), null);
  const sparse = comment(); sparse.rich_text[0].extra = new Array(2);
  assert.equal(await fingerprint(sparse), null);
  const badKey = comment(); badKey.rich_text[0]['\uD800'] = 'Value';
  assert.equal(await fingerprint(badKey), null);
});

test('JSON nesting is supported through 32 containers and rejected beyond that bound', async () => {
  const nested = depth => { let value = 'leaf'; for (let index = 0; index < depth; index++) value = { child: value }; return value; };
  const supported = comment(); supported.rich_text[0].extra = nested(30);
  assert.ok(await fingerprint(supported));
  const unsupported = comment(); unsupported.rich_text[0].extra = nested(31);
  assert.equal(await fingerprint(unsupported), null);
});

test('posted receipt retains the entire acknowledged JSON and fingerprint tuple', async () => {
  const snapshot = comment({ extra_metadata: { untouched: 'Original 한글🙂' } });
  const args = { page_id: ids.page.replaceAll('-', '').toUpperCase(), comment: snapshot };
  const result = await receipt(args, config());
  assert.deepEqual(result, { pageId: ids.page, ...await fingerprint(snapshot), ack: JSON.stringify(snapshot) });
  assert.deepEqual(args.comment, snapshot);
  assert.deepEqual(Object.keys(result), ['pageId', 'commentId', 'revision', 'hashVersion', 'contentHash', 'ack']);
});

test('posted receipt never reconstructs a partial create acknowledgment or trims Unicode', async () => {
  for (const snapshot of [{ object: 'comment', id: ids.comment }, comment({ rich_text: undefined }), comment({ last_edited_time: undefined }), comment({ attachments: [{}] })]) {
    await rejected(() => receipt({ page_id: ids.page, comment: snapshot }, config()));
  }
  const text = 'Full 한글🙂\n'.repeat(30000);
  const snapshot = comment({ rich_text: [{ type: 'text', text: { content: text } }], extra_metadata: { full: text } });
  const result = await receipt({ page_id: ids.page, comment: snapshot }, config());
  assert.equal(result.ack, JSON.stringify(snapshot));
  assert.equal(JSON.parse(result.ack).extra_metadata.full, text);
});

test('posted receipt accepts only exact arguments and the configured page UUID', async () => {
  for (const args of [null, [], {}, { page_id: ids.other, comment: comment() }, { page_id: '../page', comment: comment() },
    { page_id: ids.page, comment: comment(), writer: 'Companion' }]) await rejected(() => receipt(args, config()));
  for (const invalid of [undefined, {}, { pageIds: [] }, { pageIds: ['*'] }, { pageIds: [ids.page, 'bad'] }]) {
    await rejected(() => receipt({ page_id: ids.page, comment: comment() }, invalid));
  }
});

test('a supplied acknowledged page parent must agree with the configured target', async () => {
  for (const parent of [{ type: 'page_id', page_id: ids.other }, { type: 'page_id', page_id: 'bad' },
    { type: 'block_id', block_id: 'bad' }, { type: 'database_id', database_id: ids.page }, null]) {
    await rejected(() => receipt({ page_id: ids.page, comment: comment({ parent }) }, config()));
  }
  const parent = { type: 'page_id', page_id: ids.page.replaceAll('-', '').toUpperCase() };
  assert.equal((await receipt({ page_id: ids.page, comment: comment({ parent }) }, config())).pageId, ids.page);
  const block = { type: 'block_id', block_id: ids.other };
  assert.equal((await receipt({ page_id: ids.page, comment: comment({ parent: block }) }, config())).pageId, ids.page, 'A block parent does not prove or broaden page scope');
});

test('posted acknowledgment must be complete JSON even when invalid metadata is outside the content hash', async () => {
  const snapshot = comment({ ignored_metadata: undefined });
  assert.ok(await fingerprint(snapshot));
  await rejected(() => receipt({ page_id: ids.page, comment: snapshot }, config()));
  const cyclic = comment(); cyclic.ignored_metadata = cyclic;
  await rejected(() => receipt({ page_id: ids.page, comment: cyclic }, config()));
});
