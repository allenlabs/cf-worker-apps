import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
test('dashboard assets are present', async () => {
    for (const f of ['index.html', 'app.js', 'style.css'])
        await access(new URL('../public/' + f, import.meta.url));
});
test('dashboard avoids HTML injection and persistent token storage', async () => {
    const s = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    assert.doesNotMatch(s, /\.innerHTML\s*=|localStorage|sessionStorage|document\.write/);
});

test('browser API errors start only the fixed SSO login on401 and retain explicit logout', async () => {
    const { runInNewContext } = await import('node:vm');
    const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
    const api = source.match(/async function api\([\s\S]*?\n\}/)[0];
    const handleError = source.match(/function handleError\([\s\S]*?\n\}/)[0];
    for (const [status, header, signedOut, redirects] of [[401, '/auth/login', false, 1], [401, '/auth/login', true, 0], [401, 'https://external.invalid', false, 0], [403, '/auth/login', false, 0], [503, '/auth/login', false, 0]]) {
        const navigations = [], dialog = { open: false, showModal() { this.open = true; } };
        const context = {
            state: { authenticated: true, signedOut }, location: { replace(path) { navigations.push(path); } },
            fetch: async () => ({ status, ok: false, json: async () => ({ error: 'fixed-error' }), headers: { get: () => header } }),
            $: () => dialog, stopHealthPolling() {}, stopSocket() {}, notice() {},
        };
        await runInNewContext(`(async () => { ${api}\n${handleError}\ntry { await api('/api/health'); } catch (error) { handleError(error); } })()`, context);
        assert.equal(navigations.length, redirects);
        if (redirects) assert.equal(navigations[0], '/auth/login');
        if (status === 401 && !redirects) assert.equal(dialog.open, true);
    }
    const boot = source.slice(source.lastIndexOf("try {\n    const health = await api('/api/health');"));
    const signedOutState = { authenticated: false, signedOut: true };
    await runInNewContext(`(async () => { ${boot} })()`, { state: signedOutState, api: async () => ({}), startHealthPolling() { throw Error('late health response restarted polling'); }, updateHealth() {}, search() { throw Error('late health response restarted queries'); }, handleError(error) { throw error; } });
    assert.equal(signedOutState.authenticated, false);
    const registration = source.slice(source.indexOf("if (!sso) $('loginForm')"), source.indexOf("$('logoutButton').addEventListener"));
    assert.ok(registration);
    runInNewContext(registration, { sso: true, $() { throw Error('SSO browser must not register or read token login'); } });
});
