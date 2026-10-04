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
