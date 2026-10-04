import { test } from 'vitest';
import assert from 'node:assert/strict';
import { estimate } from '../scripts/cost.mjs';
test('10-second archive writes stay within an otherwise-unused Class A allowance', () => {
    const x = estimate();
    assert.equal(x.classA, 518400);
    assert.equal(x.dollars.classA, 0);
    assert.equal(x.dollars.storage, 1.35);
});
test('1-second writes account for both PUTs and upward billing-unit rounding', () => {
    const x = estimate({ flushSeconds: 1 });
    assert.equal(x.classA, 5184000);
    assert.equal(x.dollars.classA, 22.5);
});
test('idle ingestion does not create R2 files', () => {
    const x = estimate({ activeSeconds: 0, extraReads: 0, averageGB: 0 });
    assert.equal(x.classA, 0);
    assert.equal(x.dollars.r2OnlyTotal, 0);
});
test('invalid cost parameters are rejected', () => assert.throws(() => estimate({ flushSeconds: 0 })));
