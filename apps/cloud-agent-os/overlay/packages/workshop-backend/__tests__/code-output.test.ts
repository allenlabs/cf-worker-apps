import { env, type WorkerEntrypoint } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { codeOutputModuleSource, type CodeOutputOptions, type CodeOutputResult } from '../src/code-output';

let serial = 0;
interface TestOutputEntrypoint extends WorkerEntrypoint {
  verify(): void;
  run(): Promise<CodeOutputResult>;
}
interface TestFixtureEntrypoint extends WorkerEntrypoint {
  run(): Promise<unknown>;
}

/** Exercise the canonical raw collector source inside a real isolated Worker, never eval in the host. */
async function fixture<T = CodeOutputResult>(body: string, options: CodeOutputOptions = {}): Promise<T> {
  const worker = env.LOADER.get(`code-output-unit-${++serial}`, () => ({
    compatibilityDate: '2026-02-01', compatibilityFlags: ['disallow_importable_env'],
    mainModule: 'fixture.js', globalOutbound: null,
    modules: {
      'capture.js': codeOutputModuleSource({ mirror: false }),
      'fixture.js': `import { WorkerEntrypoint } from 'cloudflare:workers';
import { createCodeOutputCollector } from './capture.js';
export default class extends WorkerEntrypoint {
  async run() {
    const forwarded = [];
    const original = (...args) => { forwarded.push(args); };
    const target = { log: original, info: original, warn: original, error: original, debug: original,
      trace: original, marker: 'untouched' };
    const collector = createCodeOutputCollector(${JSON.stringify({ mirror: false, ...options })});
    collector.install(target);
    ${body}
  }
}`,
    },
  })).getEntrypoint<TestFixtureEntrypoint>();
  return await worker.run() as T;
}

function loaded(code: string, options: CodeOutputOptions = {}) {
  return env.LOADER.get(`code-output-fixture-${++serial}`, () => ({
    compatibilityDate: '2026-02-01', compatibilityFlags: ['disallow_importable_env'],
    mainModule: 'harness.js', globalOutbound: null,
    modules: {
      'capture.js': codeOutputModuleSource({ mirror: false, ...options }),
      'agent.js': code,
      'harness.js': `import { WorkerEntrypoint } from 'cloudflare:workers';
import { output } from './capture.js';
export default class extends WorkerEntrypoint {
  verify() {}
  run() {
    return output.run(async () => {
      const { default: agent } = await import('./agent.js');
      return agent(output.context(this.ctx));
    });
  }
}`,
    },
  })).getEntrypoint<TestOutputEntrypoint>();
}

describe('canonical code output', () => {
  it.each([0, -1, 0.5, NaN, Infinity, 4 * 1024 * 1024 + 1])('rejects an invalid output limit (%s)', async maxBytes => {
    const error = await fixture<string>(`try {
      createCodeOutputCollector({ maxBytes: ${String(maxBytes)} });
    } catch (error) { return error.message; }`);
    expect(error).toMatch(/output.*limit/i);
  });

  it('snapshots console arguments at call time and preserves every supported console level', async () => {
    const actual = await fixture<{ result: CodeOutputResult; traceUntouched: boolean; marker: string }>(`
      const value = { z: 2, a: { value: 1 } };
      target.log('before', value);
      value.a.value = 99;
      target.info(undefined, null, 42, true, 123n, NaN);
      target.warn('warning');
      target.error('error');
      target.debug('debug');
      const result = await collector.run(() => ({ done: true }));
      return { result, traceUntouched: target.trace === original, marker: target.marker };
    `);
    expect(actual.result).toEqual({ output: 'before {"a":{"value":1},"z":2}\nundefined null 42 true 123n NaN\nwarning\nerror\ndebug\nReturn value: {"done":true}' });
    expect(actual.traceUntouched).toBe(true);
    expect(actual.marker).toBe('untouched');
  });

  it('renders cycles and accessors explicitly without evaluating a getter', async () => {
    const result = await fixture(`
      const value = {};
      value.self = value;
      Object.defineProperty(value, 'secret', { enumerable: true, get() { throw new Error('Getter must not run'); } });
      target.log(value);
      return collector.run(() => undefined);
    `);
    expect(result.output).toBe('{"secret":"[Getter]","self":"[Circular]"}');
  });

  it('keeps readable contents of Maps, Sets, dates, expressions, and byte arrays', async () => {
    const result = await fixture(`
      target.log(new Map([['z', 2], ['a', 1]]), new Set([2, 1]), new Date('2026-01-01T00:00:00Z'), /x/gi, new Uint8Array([1, 255]));
      return collector.run(() => undefined);
    `);
    expect(result.output).toBe('Map([["z",2],["a",1]]) Set([2,1]) "2026-01-01T00:00:00.000Z" /x/gi Uint8Array([1,255])');
  });

  it('latches a rejected overlimit event even when the executed code catches the exception', async () => {
    const actual = await fixture<{ result: CodeOutputResult; rejected: string; forwarded: unknown[][] }>(`
      target.log('accepted original');
      let rejected;
      try { target.log('x'.repeat(1024)); } catch (error) { rejected = error.message; }
      const result = await collector.run(() => {
        try { target.log('after the rejected event'); } catch {}
        return undefined;
      });
      return { result, rejected, forwarded };
    `, { maxBytes: 1024, mirror: true });
    expect(actual.rejected).toMatch(/output.*limit/i);
    expect(actual.result.output).toBe('accepted original');
    expect(actual.result.error).toMatch(/output.*limit/i);
    expect(actual.result.error).toMatch(/effects may already have occurred/i);
    expect(actual.result.error).toMatch(/do not automatically repeat/i);
    expect(actual.forwarded).toEqual([['accepted original']]);
  });

  it('counts separators for empty console events against the same byte budget', async () => {
    const actual = await fixture<{ result: CodeOutputResult; rejected: string }>(`
      target.log();
      target.log();
      let rejected;
      try { target.log(); } catch (error) { rejected = error.message; }
      return { result: await collector.run(() => undefined), rejected };
    `, { maxBytes: 1 });
    expect(actual.rejected).toMatch(/output.*limit/i);
    expect(actual.result.output).toBe('\n');
    expect(actual.result.error).toMatch(/output.*limit/i);
  });

  it('captures a thrown error without losing previously accepted output or rerunning the callback', async () => {
    const actual = await fixture<{ first: CodeOutputResult; second: CodeOutputResult; calls: number }>(`
      let calls = 0;
      const callback = () => { calls++; target.log('completed operation'); throw new Error('Failure after operation'); };
      const first = await collector.run(callback);
      const second = await collector.run(callback);
      return { first, second, calls };
    `);
    expect(actual.first.output).toBe('completed operation');
    expect(actual.first.error).toContain('Failure after operation');
    expect(actual.second).toEqual(actual.first);
    expect(actual.calls).toBe(1);
  });

  it('preserves context method receivers while waiting for nested waitUntil tasks and collecting their errors', async () => {
    const actual = await fixture<{ result: CodeOutputResult; bound: number }>(`
      const base = { marker: 123, waitUntil(_promise) {}, bound() { return this.marker; } };
      const ctx = collector.context(base);
      const bound = ctx.bound();
      const result = await collector.run(() => {
        ctx.waitUntil(Promise.resolve().then(() => {
          target.log('outer work completed');
          ctx.waitUntil(Promise.resolve().then(() => { target.log('nested work completed'); throw new Error('Background failure'); }));
        }));
        return 'returned value';
      });
      return { result, bound };
    `);
    expect(actual.bound).toBe(123);
    expect(actual.result.output).toContain('outer work completed');
    expect(actual.result.output).toContain('nested work completed');
    expect(actual.result.output).toContain('Return value: returned value');
    expect(actual.result.error).toContain('Background failure');
  });

  it('rejects invalid Unicode before accepting an event for UTF-8 archival', async () => {
    const result = await fixture(`
      target.log('original');
      return collector.run(() => target.log('\\ud800'));
    `);
    expect(result.output).toBe('original');
    expect(result.error).toMatch(/Unicode/i);
  });
});

describe('isolated WorkerLoader code output channel', () => {
  it('returns more than 300KB of complete console output and its return value independently of platform tails', async () => {
    const worker = loaded(`console.info('module initialization');
export default () => { console.log('x'.repeat(320_000)); return 'RETURN-END'; };`);
    await worker.verify();
    const result = await worker.run();
    expect(result).toEqual({ output: 'module initialization\n' + 'x'.repeat(320_000) + '\nReturn value: RETURN-END' });
    // The pool exposes freshly bound console functions, so check isolation by behavior:
    // the parent can still log after the child collector has closed, and it is not archived.
    expect(() => console.log('parent console is separate')).not.toThrow();
    expect(await worker.run()).toEqual(result);
  });

  it('can return the complete accepted 4MiB output ceiling through WorkerLoader RPC', async () => {
    const result = await loaded(`export default () => { console.log('z'.repeat(4 * 1024 * 1024)); };`).run();
    expect(result.error).toBeUndefined();
    expect(result.output).toBe('z'.repeat(4 * 1024 * 1024));
  });

  it('returns module initialization output when module evaluation fails', async () => {
    const result = await loaded(`console.log('before module failure');
throw new Error('Module failed after logging');
export default () => 'unreachable';`).run();
    expect(result.output).toBe('before module failure');
    expect(result.error).toContain('Module failed after logging');
    expect(result.error).toMatch(/do not automatically repeat/i);
  });

  it('awaits real execution-context waitUntil logs and nested work before returning', async () => {
    const result = await loaded(`export default ctx => {
  ctx.waitUntil(Promise.resolve().then(() => {
    console.log('background output');
    ctx.waitUntil(Promise.resolve().then(() => console.warn('nested output')));
  }));
  return 'foreground return';
};`).run();
    expect(result.error).toBeUndefined();
    expect(result.output).toContain('background output');
    expect(result.output).toContain('nested output');
    expect(result.output).toContain('Return value: foreground return');
  });

  it.each(['Error', 'DOMException'] as const)('retains prior output when execution reports %s', async kind => {
    const result = await loaded(`export default () => {
  console.log('saved before failure');
  throw ${kind === 'DOMException' ? "new DOMException('Execution cancelled', 'AbortError')" : "new Error('Execution failed')"};
};`).run();
    expect(result.output).toBe('saved before failure');
    expect(result.error).toContain(kind === 'DOMException' ? 'Execution cancelled' : 'Execution failed');
    expect(result.error).toMatch(/effects may already have occurred/i);
  });

  it('preserves complete accepted events when an isolated execution reaches the output budget', async () => {
    const result = await loaded(`export default () => {
  console.log('first complete event');
  console.log('x'.repeat(1024));
  return 'unreachable';
};`, { maxBytes: 1024 }).run();
    expect(result.output).toBe('first complete event');
    expect(result.error).toMatch(/output.*limit/i);
    expect(result.error).toMatch(/do not automatically repeat/i);
  });
});
