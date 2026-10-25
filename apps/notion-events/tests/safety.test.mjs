import assert from 'node:assert/strict';
import { test } from 'node:test';

const safety = await import('../workers/api/safety.js').catch(() => ({}));
test('archive pages preserve complete UTF-8 source bytes and reject mid-character cursors', () => {
  assert.equal(typeof safety.archivePage, 'function', 'archive pagination is implemented');
  const source = '\ufeff' + JSON.stringify({ text: '한글😀\\"\n'.repeat(300) });
  let cursor = '0', restored = '';
  do {
    const page = safety.archivePage(source, cursor, 33);
    assert.equal(Buffer.byteLength(page.text), Number(page.next_cursor ?? page.total_bytes) - Number(cursor));
    restored += page.text;
    cursor = page.next_cursor;
  } while (cursor !== null);
  assert.equal(restored, source);
  assert.throws(() => safety.archivePage('😀data', '1', 32));
  for (const cursor of ['-1', '1e2', '01', '2.5', '9007199254740992']) assert.throws(() => safety.archivePage(source, cursor, 32));
});
test('callback DNS guards reject private IPv4, IPv6, mapped and mixed answers on every attempt', async () => {
  assert.equal(typeof safety.verifyCallbackDestination, 'function', 'callback DNS validation is implemented');
  for (const address of ['127.0.0.1', '10.2.3.4', '169.254.169.254', '192.168.1.1', '100.64.0.1', '198.18.0.1', '0.0.0.0', '224.1.1.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1']) {
    await assert.rejects(safety.verifyCallbackDestination('https://chatgpt.com/events', async () => Response.json({ Status: 0, Answer: [{ type: address.includes(':') ? 28 : 1, data: address }] })));
  }
  let lookups = 0;
  const resolver = async request => {
    lookups++;
    assert.equal(new URL(request).hostname, 'cloudflare-dns.com');
    return Response.json({ Status: 0, Answer: [{ type: 1, data: '104.18.32.7' }, { type: 28, data: '2606:4700::1111' }] });
  };
  await safety.verifyCallbackDestination('https://chatgpt.com/events', resolver);
  await safety.verifyCallbackDestination('https://chatgpt.com/events', resolver);
  assert.equal(lookups, 4, 'both address families are checked before each attempt');
  for (const url of ['https://chatgpt.com.attacker.invalid/events', 'http://chatgpt.com/events', 'https://user@chatgpt.com/events', 'https://chatgpt.com:444/events', 'https://127.0.0.1/events']) {
    await assert.rejects(safety.verifyCallbackDestination(url, resolver));
  }
  assert.equal(lookups, 4, 'untrusted URLs fail before DNS');
});
