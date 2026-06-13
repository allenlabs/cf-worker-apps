import { describe, expect, it } from 'vitest';
import { createPmHost } from '../../src/host/create-host';
import { definePmPlugin, type PmContext } from '../../src/host/types';

// A throwaway context — these tests never touch the DB; they only assert the
// host's fan-out / ordering / validation, so a cast is enough.
const ctx = {} as PmContext;

describe('createPmHost', () => {
  it('exposes the registered ids in order and answers has()', () => {
    const host = createPmHost([
      definePmPlugin({ id: 'a' }),
      definePmPlugin({ id: 'b' }),
    ]);
    expect(host.pluginIds).toEqual(['a', 'b']);
    expect(host.has('a')).toBe(true);
    expect(host.has('nope')).toBe(false);
  });

  it('dispatches a hook to every subscriber in registration order', async () => {
    const calls: string[] = [];
    const host = createPmHost([
      definePmPlugin({
        id: 'first',
        hooks: {
          async onIssueCreated() {
            calls.push('first');
          },
        },
      }),
      definePmPlugin({
        id: 'second',
        hooks: {
          async onIssueCreated() {
            calls.push('second');
          },
        },
      }),
    ]);
    await host.dispatch('onIssueCreated', ctx, { issue: {} as never, input: {} as never });
    expect(calls).toEqual(['first', 'second']);
  });

  it('passes the context and event through to the hook', async () => {
    let received: unknown;
    const host = createPmHost([
      definePmPlugin({
        id: 'capture',
        hooks: {
          async onBeforeIssueCreate(_ctx, event) {
            received = event;
          },
        },
      }),
    ]);
    const event = { projectId: 7, input: {} as never };
    await host.dispatch('onBeforeIssueCreate', ctx, event);
    expect(received).toBe(event);
  });

  it('is a no-op when no plugin subscribes to the hook', async () => {
    const host = createPmHost([definePmPlugin({ id: 'inert' })]);
    await expect(
      host.dispatch('onIssueCreated', ctx, { issue: {} as never, input: {} as never }),
    ).resolves.toBeUndefined();
  });

  it('skips a plugin whose hooks object omits the dispatched hook', async () => {
    const calls: string[] = [];
    const host = createPmHost([
      definePmPlugin({
        id: 'only-update',
        hooks: {
          async onIssueUpdated() {
            calls.push('update');
          },
        },
      }),
      definePmPlugin({
        id: 'only-create',
        hooks: {
          async onIssueCreated() {
            calls.push('create');
          },
        },
      }),
    ]);
    await host.dispatch('onIssueCreated', ctx, { issue: {} as never, input: {} as never });
    expect(calls).toEqual(['create']);
  });

  it('propagates an error thrown by a hook (sequential, fail-fast)', async () => {
    const calls: string[] = [];
    const host = createPmHost([
      definePmPlugin({
        id: 'boom',
        hooks: {
          async onIssueCreated() {
            throw new Error('hook failed');
          },
        },
      }),
      definePmPlugin({
        id: 'after',
        hooks: {
          async onIssueCreated() {
            calls.push('after');
          },
        },
      }),
    ]);
    await expect(
      host.dispatch('onIssueCreated', ctx, { issue: {} as never, input: {} as never }),
    ).rejects.toThrow(/hook failed/);
    expect(calls).toEqual([]); // second hook never ran
  });

  it('ignores a hook key explicitly set to undefined', async () => {
    const calls: string[] = [];
    const host = createPmHost([
      definePmPlugin({
        id: 'partial',
        // A key present but undefined (e.g. `hooks: { onIssueCreated: cond ? fn : undefined }`)
        // must not register a subscriber.
        hooks: { onIssueCreated: undefined, onIssueUpdated: async () => { calls.push('updated'); } },
      }),
    ]);
    await host.dispatch('onIssueCreated', ctx, { issue: {} as never, input: {} as never });
    expect(calls).toEqual([]);
    await host.dispatch('onIssueUpdated', ctx, {
      before: {} as never,
      after: {} as never,
      patch: {},
      notes: '',
    });
    expect(calls).toEqual(['updated']);
  });

  it('throws on a duplicate plugin id', () => {
    expect(() =>
      createPmHost([definePmPlugin({ id: 'dup' }), definePmPlugin({ id: 'dup' })]),
    ).toThrow(/Duplicate plugin id "dup"/);
  });

  it('throws when a plugin depends on an id not registered before it', () => {
    expect(() =>
      createPmHost([
        definePmPlugin({ id: 'needy', dependsOn: ['missing'] }),
      ]),
    ).toThrow(/depends on "missing"/);
  });

  it('accepts a dependsOn satisfied by an earlier plugin', () => {
    const host = createPmHost([
      definePmPlugin({ id: 'base' }),
      definePmPlugin({ id: 'dependent', dependsOn: ['base'] }),
    ]);
    expect(host.pluginIds).toEqual(['base', 'dependent']);
  });
});
