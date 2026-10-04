/** R2 Standard only. Does NOT estimate Worker/DO CPU, requests, rows or taxes. */
import { pathToFileURL } from 'node:url';
export function estimate({ flushSeconds = 10, activeSeconds = 30 * 86400, averageGB = 100, extraReads = 100000, freeA = 1000000, freeB = 10000000, freeGB = 10 } = {}) {
    for (const [key, value] of Object.entries({ flushSeconds, activeSeconds, averageGB, extraReads, freeA, freeB, freeGB }))
        if (!Number.isFinite(value) || value < 0)
            throw new Error(`${key} must be a non-negative finite number`);
    if (flushSeconds < 1 || flushSeconds > 60)
        throw new Error('flushSeconds must be 1..60');
    const flushes = Math.ceil(activeSeconds / flushSeconds), classA = 2 * flushes, classB = flushes + extraReads;
    const dollars = { classA: Math.ceil(Math.max(0, classA - freeA) / 1e6) * 4.5, classB: Math.ceil(Math.max(0, classB - freeB) / 1e6) * .36, storage: Number((Math.ceil(Math.max(0, averageGB - freeGB)) * .015).toFixed(3)) };
    return { assumptions: { flushSeconds, activeSeconds, averageGB, extraReads, freeA, freeB, freeGB }, flushes, classA, classB, dollars: { ...dollars, r2OnlyTotal: Number(Object.values(dollars).reduce((a, b) => a + b, 0).toFixed(2)) }, warning: 'R2-only estimate. Assumes one segment + one index PUT per nonempty flush, no failures/overflow flushes. Account allowances are shared. Workers and Durable Objects costs are excluded.' };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        const options = {};
        for (const arg of process.argv.slice(2)) {
            const match = /^--(\w+)=(.+)$/.exec(arg);
            if (!match)
                throw new Error('Use --flushSeconds=10 --averageGB=100; see docs/COST.md');
            options[match[1]] = Number(match[2]);
        }
        const allowed = new Set(['flushSeconds', 'activeSeconds', 'averageGB', 'extraReads', 'freeA', 'freeB', 'freeGB']);
        for (const k of Object.keys(options))
            if (!allowed.has(k))
                throw new Error(`Unknown option ${k}`);
        console.log(JSON.stringify(estimate(options), null, 2));
    }
    catch (e) {
        console.error(e.message);
        process.exitCode = 1;
    }
}
