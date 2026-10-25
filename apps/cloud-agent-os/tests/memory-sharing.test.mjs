import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectMemorySources, searchMemoryProfiles } from '../overlay/packages/workshop-backend/src/memory-sharing.ts';

const id = '11111111-1111-4111-8111-111111111111';
const bots = [{ id, name: 'Research', archived: false }];

test('Standard assistant is the common owner source and is searched once', () => {
  assert.deepEqual(selectMemorySources(null, bots), [
    { kind: 'common', botId: null, label: 'Common memory (Standard assistant)' },
  ]);
});

test('all-bot recall searches each bot and common owner profile once', () => {
  const sources = selectMemorySources(id, bots, { scope: 'all' });
  assert.deepEqual(sources.map(source => source.kind), ['bot', 'common']);
  assert.equal(sources.filter(source => source.botId === null).length, 1);
});

const other = '22222222-2222-4222-8222-222222222222';
const catalog = [...bots, { id: other, name: 'Archived bot', archived: true }];
function searchInput(overrides = {}) {
  return {
    principal: 'owner@example.invalid', currentBotId: id, bots: catalog, query: '한국어 context',
    profileName: value => `bot:${value}`, commonName: () => 'common',
    binding: { async getProfile(name) { return { async recall() { return { count: 1, answer: name, candidates: [] }; } }; } },
    ...overrides,
  };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

for (const phase of ['getProfile', 'recall']) {
  test(`a stalled ${phase} becomes a partial source error after 90 seconds`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    let result;
    const pending = searchMemoryProfiles(searchInput({ binding: {
      async getProfile(name) {
        if (name === `bot:${id}` && phase === 'getProfile') return new Promise(() => {});
        return { async recall() {
          if (name === `bot:${id}`) return new Promise(() => {});
          return { count: 1, answer: 'available common context', candidates: [] };
        } };
      },
    } })).then(value => { result = value; });
    await flush();
    t.mock.timers.tick(89_999); await flush();
    assert.equal(result, undefined);
    t.mock.timers.tick(1); await flush();
    assert.ok(result, 'the bounded lookup must settle after 90 seconds');
    await pending;
    assert.equal(result.complete, false);
    assert.deepEqual(result.sources[0], { kind: 'bot', botId: id, label: 'Research', error: 'Memory lookup failed' });
    assert.equal(result.sources[1].answer, 'available common context');
  });
}

test('the timeout covers profile resolution and recall together', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let result;
  const delay = () => new Promise(resolve => setTimeout(resolve, 60_000));
  const pending = searchMemoryProfiles(searchInput({ currentBotId: null, binding: {
    async getProfile() { await delay(); return { async recall() { await delay(); return { count: 0, candidates: [] }; } }; },
  } })).then(value => { result = value; });
  await flush(); t.mock.timers.tick(60_000); await flush();
  assert.equal(result, undefined);
  t.mock.timers.tick(30_000); await flush();
  assert.ok(result, 'two slow phases must share one 90-second budget');
  await pending;
  assert.equal(result.complete, false);
  assert.equal(result.sources[0].error, 'Memory lookup failed');
});

test('timed-out uncancellable calls retain their slots and explicitly report unattempted sources', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const many = Array.from({ length: 8 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: `Bot ${index}`, archived: false }));
  let active = 0, maximum = 0, result;
  const pending = searchMemoryProfiles(searchInput({ currentBotId: null, bots: many, options: { scope: 'all' }, binding: {
    async getProfile() {
      active++; maximum = Math.max(maximum, active);
      return { async recall() { return new Promise(() => {}); } };
    },
  } })).then(value => { result = value; });
  await flush();
  assert.equal(active, 4);
  t.mock.timers.tick(90_000); await flush();
  assert.equal(maximum, 4, 'timed-out remote calls must not free slots for additional calls');
  assert.ok(result, 'all retired slots must complete the bounded partial response');
  await pending;
  assert.equal(result.complete, false);
  assert.equal(result.sources.length, 9);
  assert.equal(result.sources.filter(source => source.error === 'Memory lookup failed').length, 4);
  assert.equal(result.sources.filter(source => source.error === 'Memory lookup not attempted because earlier requests timed out').length, 5);
});

test('invalid owner, unauthorized selections and oversized catalogs never query a profile', async () => {
  let calls = 0;
  const binding = { async getProfile() { calls++; throw Error('must not query'); } };
  for (const principal of ['', '  ', '\ud800']) {
    await assert.rejects(() => searchMemoryProfiles(searchInput({ principal, binding })), /verified memory owner/);
  }
  await assert.rejects(() => searchMemoryProfiles(searchInput({ binding, options: { scope: 'selected', botIds: ['99999999-9999-4999-8999-999999999999'] } })), /not available/);
  await assert.rejects(() => searchMemoryProfiles(searchInput({ binding, bots: [{ ...bots[0], id: { toString: () => id } }] })), /Invalid authorized bot catalog/);
  await assert.rejects(() => searchMemoryProfiles(searchInput({ binding, bots: [bots[0], bots[0]] })), /Duplicate bot identifier/);
  const many = Array.from({ length: 65 }, (_, index) => ({ id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, name: 'Synthetic bot', archived: false }));
  await assert.rejects(() => searchMemoryProfiles(searchInput({ binding, bots: many, options: { scope: 'all' } })), /too many/i);
  assert.equal(calls, 0);
});

test('selected and all scopes query each authorized destination once with intact query and optional answer', async () => {
  for (const options of [{ scope: 'selected', botIds: [id, other, other] }, { scope: 'all' }]) {
    const calls = [];
    const result = await searchMemoryProfiles(searchInput({ options, binding: {
      async getProfile(name) { return { async recall(query, opts) {
        calls.push({ name, query, opts }); return { count: 0, candidates: [] };
      } }; },
    } }));
    assert.equal(result.complete, true);
    assert.deepEqual(calls.map(call => call.name), [`bot:${id}`, 'common', `bot:${other}`]);
    assert.ok(calls.every(call => call.query === '한국어 context'));
    assert.ok(calls.every(call => call.opts.thinkingLevel === 'low' && call.opts.responseLength === 'short'));
    assert.deepEqual(result.sources.map(source => source.botId), [id, null, other]);
    assert.equal(result.sources[2].label, 'Archived bot');
    assert.equal(result.sources[0].answer, undefined);
  }
});
