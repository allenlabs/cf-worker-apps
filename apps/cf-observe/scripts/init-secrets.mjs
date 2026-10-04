/** Local development only. Creates, never overwrites, an ignored .dev.vars file. */
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
try {
    const values = `INGEST_TOKEN=${randomBytes(32).toString('hex')}\nVIEWER_TOKEN=${randomBytes(32).toString('hex')}\n`;
    await writeFile(new URL('../workers/web/.dev.vars', import.meta.url), values, { flag: 'wx', mode: 0o600 });
    console.log('Created workers/web/.dev.vars locally. Never commit it. Set production secrets separately with npm run secret:ingest and npm run secret:viewer.');
}
catch (e) {
    console.error(e.code === 'EEXIST' ? '.dev.vars already exists; no changes made.' : e.message);
    process.exitCode = 1;
}
