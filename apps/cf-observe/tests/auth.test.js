import { test } from 'vitest';
import assert from 'node:assert/strict';
import { makeEnv } from './helpers.js';
const auth = await import('../src/auth.js').catch(() => ({}));
test('auth module exists', () => assert.equal(typeof auth.sign, 'function'));
test('signed sessions cannot be forged and expired sessions are rejected', async () => {
    const env = makeEnv();
    const token = await auth.sign(env, { purpose: 'session', exp: Date.now() + 10000 });
    assert.equal((await auth.verify(env, token, 'session')).purpose, 'session');
    await assert.rejects(() => auth.verify(env, token + 'x', 'session'));
    const old = await auth.sign(env, { purpose: 'session', exp: 1 });
    await assert.rejects(() => auth.verify(env, old, 'session'));
});
test('viewer and ingest tokens have separate privileges', async () => {
    const env = makeEnv();
    await auth.authorizeIngest(new Request('https://test/v1/logs', { headers: { authorization: `Bearer ${env.INGEST_TOKEN}` } }), env);
    await assert.rejects(() => auth.authorizeIngest(new Request('https://test/v1/logs', { headers: { authorization: `Bearer ${env.VIEWER_TOKEN}` } }), env));
});
test('cross-origin browser requests are rejected', () => {
    assert.throws(() => auth.requireSameOrigin(new Request('https://test/api/live', { headers: { origin: 'https://evil.test' } })), e => e.status === 403);
});
test('short or shared secrets fail closed', async () => {
    const env = makeEnv({ VIEWER_TOKEN: 'short' });
    assert.throws(() => auth.requireSecrets(env), e => e.status === 503);
    assert.throws(() => auth.requireSecrets(makeEnv({ VIEWER_TOKEN: 'i'.repeat(48) })), e => e.status === 503);
});
test('copied example placeholders cannot authenticate a deployment', () => {
    assert.throws(() => auth.requireSecrets(makeEnv({ INGEST_TOKEN: 'replace-with-an-actually-random-ingestion-token', VIEWER_TOKEN: 'replace-with-a-different-random-viewer-token' })), e => e.status === 503);
});
