import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
let files = 0;
async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory())
            await walk(p);
        else if (/\.(mjs|js)$/.test(e.name)) {
            const r = spawnSync(process.execPath, ['--check', p], { encoding: 'utf8' });
            if (r.status !== 0) {
                process.stderr.write(r.stderr);
                process.exit(1);
            }
            files++;
        }
    }
}
for (const d of ['src', 'public', 'scripts', 'tests', 'examples'])
    await walk(d);
console.log(`Syntax checked ${files} JavaScript modules.`);
