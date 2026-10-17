import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { createFauxCore, fauxAssistantMessage, fauxText, fauxToolCall, Type, getSystemMessageText } from '@earendil-works/pi-ai';
import type { Message } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { runOpenCodeLoop } from '../src/opencode-loop';
import './test-worker';
let count = 0;

async function run(stop: boolean, cancel: boolean, extra: 'unknown' | 'malformed' | 'native' | undefined = undefined) {
  return runInDurableObject(env.TEST_OVERSEER.getByName(`native-loop-${++count}`), async instance => {
    const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
    storage.sql.exec('CREATE TABLE native_unowned_sentinel (payload TEXT)');
    storage.sql.exec("INSERT INTO native_unowned_sentinel VALUES ('untouched')");
    const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
    const trace: string[] = [];
    const controller = new AbortController();
    const initial: Message[] = [
      { role: 'system', content: [{ type: 'text', text: 'Pinned OS instructions' }], timestamp: 0 },
      { role: 'user', content: 'Do the task', timestamp: 0 },
    ];
    faux.setResponses([
      () => { trace.push('provider:1'); return fauxAssistantMessage([
        fauxToolCall('mutate', { value: 1 }, { id: 'first' }),
        ...(extra === 'unknown' ? [fauxToolCall('missing', {}, { id: 'unknown' })] : []),
        ...(extra === 'malformed' ? [fauxToolCall('mutate', JSON.parse('[]'), { id: 'malformed' })] : []),
        ...(extra === 'native' ? [fauxToolCall('execute', { code: 'return "native bypass";' }, { id: 'native' })] : []),
        fauxToolCall('mutate', { value: 2 }, { id: 'second' }),
      ], { stopReason: 'toolUse' }); },
      (context: { messages: Message[] }) => {
        trace.push('provider:2');
        expect(getSystemMessageText(context.messages[0])).toBe('Pinned OS instructions');
        const results = context.messages.filter(message => message.role === 'toolResult' && message.toolName === 'mutate' && !message.isError);
        expect(results.map(result => result.details)).toEqual([{ value: 1 }, { value: 2 }]);
        return fauxAssistantMessage(fauxText('Done'));
      },
    ]);
    let commits = 0;
    let persisted = 0;
    let staged = 0;
    let caught = '';
    try {
      await runOpenCodeLoop({ storage, chatId: 1, handle: { model: faux.getModel(), stream: faux.stream },
        maxTokens: 1024, signal: controller.signal,
        context: { messages: initial, tools: [{ name: 'mutate', label: 'Mutate', description: 'Synthetic OS mutation',
          parameters: Type.Object({ value: Type.Number() }),
          async execute(id, input) {
            trace.push(`body:${id}`);
            if (extra && id === 'first') { await scheduler.wait(25); expect(trace.includes('body:second')).toBe(false); }
            staged += input.value;
            if (cancel) controller.abort(new Error('Synthetic cancellation'));
            return { content: [{ type: 'text', text: `value=${input.value}` }], details: { value: input.value } };
          },
        }] },
        finishTurn: () => stop || cancel ? { action: 'end' } : undefined,
        async emit(event) { if (event.type === 'turn_end') {
          if (extra && commits === 0) {
            const rejected = event.toolResults.find(result => result.toolCallId === extra);
            expect(rejected?.isError).toBe(true);
            expect(event.toolResults.map(result => result.toolCallId)).toEqual(['first', extra, 'second']);
            if (extra === 'native') expect(rejected?.content).toEqual([{ type: 'text', text: expect.stringContaining('No tool named') }]);
          }
          commits++; persisted += staged; staged = 0; trace.push(`commit:${commits}`); } },
      });
    } catch (error) { caught = String(error); }
    expect(caught).toBe('');
    expect(persisted).toBe(cancel ? 1 : 3);
    expect(commits).toBe(stop || cancel ? 1 : 2);
    expect(trace).toEqual(cancel ? ['provider:1', 'body:first', 'commit:1'] : stop
      ? ['provider:1', 'body:first', 'body:second', 'commit:1']
      : ['provider:1', 'body:first', 'body:second', 'commit:1', 'provider:2', 'commit:2']);
    expect(storage.sql.exec('SELECT * FROM native_unowned_sentinel').toArray()).toEqual([{ payload: 'untouched' }]);
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'os_native_%'").toArray()).toEqual([]);
    expect(await storage.get('os:opencode-loop:owned:1')).toBeUndefined();
  });
}

describe('native OpenCode OS adapter', () => {
  it('runs real native tool steps and retains OS history and details behind each barrier', () => run(false, false));
  it('stops after the committed approval boundary without a second inference', () => run(true, false));
  it('serializes known calls across an unknown native tool rejection', () => run(false, false, 'unknown'));
  it('rejects malformed arguments without blocking the next authorized call', () => run(false, false, 'malformed'));
  it('disables the synthesized native CodeMode execute tool', () => run(false, false, 'native'));
  it('persists the completed callback when cancellation prevents the next callback', () => run(false, true));
});

it.each(['eof', 'provider-failure', 'final-failure', 'cancel-provider'] as const)(
  'keeps the provider EOF and commit barriers for %s', async mode => {
    await runInDurableObject(env.TEST_OVERSEER.getByName(`native-eof-${++count}`), async instance => {
      const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
      const { AssistantMessageEventStream } = await import('@earendil-works/pi-ai');
      const held = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const commitStarted = Promise.withResolvers<void>();
      const commitRelease = Promise.withResolvers<void>();
      const controller = new AbortController();
      const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
      faux.setResponses([
        fauxAssistantMessage(fauxToolCall('mutate', {}, { id: 'mutation' }), { stopReason: 'toolUse' }),
        fauxAssistantMessage(fauxText('Final')),
      ]);
      let requests = 0;
      let bodies = 0;
      let commits = 0;
      let failures = 0;
      const running = runOpenCodeLoop({ storage, chatId: 1, maxTokens: 1024, signal: controller.signal,
        context: { messages: [{ role: 'user', content: 'Synthetic task', timestamp: 0 }], tools: [{
          name: 'mutate', label: 'Mutation', description: 'Synthetic buffered mutation', parameters: Type.Object({}),
          async execute() { bodies++; return { content: [{ type: 'text', text: 'Buffered' }], details: {} }; },
        }] },
        handle: { model: faux.getModel(), stream(model, context, options) {
          const number = ++requests;
          const source = faux.stream(model, context, options);
          return new class extends AssistantMessageEventStream {
            async *[Symbol.asyncIterator]() {
              for await (const event of source) {
                yield event;
                if (event.type === 'done' && number === (mode === 'final-failure' ? 2 : 1)) {
                  held.resolve(); await release.promise;
                  if (mode === 'provider-failure' || mode === 'final-failure') throw new Error('Synthetic failure after done frame');
                }
              }
            }
          }();
        } },
        finishTurn: () => undefined,
        async emit(event) {
          if (event.type !== 'turn_end') return;
          const message = event.message;
          if (message.role === 'assistant' && (message.stopReason === 'error' || message.stopReason === 'aborted')) { failures++; return; }
          if (mode === 'eof' && commits === 0) { commitStarted.resolve(); await commitRelease.promise; }
          commits++;
        },
      });
      await held.promise;
      expect(bodies).toBe(mode === 'final-failure' ? 1 : 0);
      expect(commits).toBe(mode === 'final-failure' ? 1 : 0);
      if (mode === 'cancel-provider') controller.abort(new Error('Synthetic cancellation'));
      release.resolve();
      if (mode === 'eof') {
        await commitStarted.promise;
        expect(requests).toBe(1); expect(commits).toBe(0);
        commitRelease.resolve();
      }
      await running;
      expect(bodies).toBe(mode === 'eof' || mode === 'final-failure' ? 1 : 0);
      expect(commits).toBe(mode === 'eof' ? 2 : mode === 'final-failure' ? 1 : 0);
      if (mode === 'provider-failure' || mode === 'final-failure') expect(failures).toBe(1);
    });
  });

it('cleans only a recorded stale prefix and restores the canonical transcript on a fresh pass', async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`native-restart-${++count}`), async instance => {
    const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
    const prefix = 'os_native_00000000000000000000000000000000_';
    await storage.put('os:opencode-loop:owned:1', [prefix]);
    storage.sql.exec(`CREATE TABLE ${prefix}stale (value TEXT)`);
    storage.sql.exec('CREATE TABLE os_canonical_sentinel (value TEXT)');
    storage.sql.exec("INSERT INTO os_canonical_sentinel VALUES ('preserved')");
    const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
    const prior = fauxAssistantMessage(fauxToolCall('mutate', { value: 1 }, { id: 'committed' }), { stopReason: 'toolUse' });
    faux.setResponses([context => {
      const restored = context.messages.find(message => message.role === 'toolResult');
      expect(restored).toMatchObject({ toolCallId: 'committed', details: { value: 1 } });
      expect(JSON.stringify(context.messages)).not.toContain('stale call');
      return fauxAssistantMessage(fauxText('Restored'));
    }]);
    let commits = 0;
    await runOpenCodeLoop({ storage, chatId: 1, maxTokens: 1024, signal: new AbortController().signal,
      handle: { model: faux.getModel(), stream: faux.stream },
      context: { messages: [{ role: 'user', content: 'Original task', timestamp: 0 }, prior,
        { role: 'toolResult', toolCallId: 'committed', toolName: 'mutate',
          content: [{ type: 'text', text: 'value=1' }], details: { value: 1 }, isError: false, timestamp: 0 }], tools: [] },
      finishTurn: () => undefined, async emit(event) { if (event.type === 'turn_end') commits++; },
    });
    expect(commits).toBe(1);
    expect(storage.sql.exec('SELECT * FROM os_canonical_sentinel').toArray()).toEqual([{ value: 'preserved' }]);
    expect(storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'os_native_%'").toArray()).toEqual([]);
  });
});

it('surfaces the native step limit after preserving the previous committed steps', async () => {
  await runInDurableObject(env.TEST_OVERSEER.getByName(`native-limit-${++count}`), async instance => {
    const storage = (instance as unknown as { impl: { ctx: DurableObjectState } }).impl.ctx.storage;
    const faux = createFauxCore({ models: [{ id: 'faux-model' }] });
    faux.setResponses(Array.from({ length: 64 }, (_, index) => fauxAssistantMessage(
      fauxToolCall('read', {}, { id: `read-${index}` }), { stopReason: 'toolUse' })));
    let commits = 0;
    await expect(runOpenCodeLoop({ storage, chatId: 1, maxTokens: 1024, signal: new AbortController().signal,
      handle: { model: faux.getModel(), stream: faux.stream },
      context: { messages: [{ role: 'user', content: 'Synthetic task', timestamp: 0 }], tools: [{
        name: 'read', label: 'Read', description: 'Synthetic read', parameters: Type.Object({}),
        async execute() { return { content: [{ type: 'text', text: 'Read' }], details: {} }; },
      }] }, finishTurn: () => undefined,
      async emit(event) { if (event.type === 'turn_end') commits++; },
    })).rejects.toThrow('exceeded 64 model steps');
    expect(commits).toBe(64);
  });
}, 30_000);
