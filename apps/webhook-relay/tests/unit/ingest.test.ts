import { beforeEach, describe, expect, it } from 'vitest';
import { buildJob, loadSubscribers } from '../../workers/ingest/index';
import type { Subscriber } from '../../shared/types';

function makeKv(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    list: async () => ({ keys: [...store.keys()].map((name) => ({ name })) }),
  } as unknown as KVNamespace;
}

const sub: Subscriber = { id: 's1', endpoint: 'https://hook.example.com' };

describe('loadSubscribers', () => {
  it('returns [] when no entry is set', async () => {
    expect(await loadSubscribers(makeKv(), 'github')).toEqual([]);
  });

  it('parses a JSON-array entry', async () => {
    const kv = makeKv({ 'subscribers:github': JSON.stringify([sub]) });
    expect(await loadSubscribers(kv, 'github')).toEqual([sub]);
  });

  it('returns [] when the entry is malformed JSON', async () => {
    const kv = makeKv({ 'subscribers:github': 'not-json' });
    expect(await loadSubscribers(kv, 'github')).toEqual([]);
  });

  it('returns [] when the entry is JSON but not an array', async () => {
    const kv = makeKv({ 'subscribers:github': '{"foo":"bar"}' });
    expect(await loadSubscribers(kv, 'github')).toEqual([]);
  });
});

describe('buildJob', () => {
  const env = {
    EVENTS: {} as unknown as Queue<unknown>,
    SUBSCRIBERS: makeKv({ 'subscribers:github': JSON.stringify([sub]) }),
    INGEST_SECRET: '',
    INITIAL_BACKOFF_MS: '500',
    MAX_ATTEMPTS: '4',
  } as any;

  beforeEach(() => {
    env.SUBSCRIBERS = makeKv({ 'subscribers:github': JSON.stringify([sub]) });
  });

  it('serialises the request body to base64 and snapshots safe headers', async () => {
    const request = new Request('https://ingest.example.com/hooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'push',
        cookie: 'session=secret', // should be filtered out
      },
      body: JSON.stringify({ hello: 'world' }),
    });
    const { event, job } = await buildJob({ request, source: 'github', env });

    expect(event.source).toBe('github');
    expect(event.headers['content-type']).toBe('application/json');
    expect(event.headers['x-github-event']).toBe('push');
    expect(event.headers['cookie']).toBeUndefined();
    expect(atob(event.bodyBase64)).toBe('{"hello":"world"}');
    expect(job.subscribers).toEqual([sub]);
    expect(job.initialBackoffMs).toBe(500);
    expect(job.maxAttempts).toBe(4);
  });

  it('produces a fresh event id per call', async () => {
    const req = () => new Request('https://x.test/hooks/github', { method: 'POST', body: '{}' });
    const a = await buildJob({ request: req(), source: 'github', env });
    const b = await buildJob({ request: req(), source: 'github', env });
    expect(a.event.id).not.toBe(b.event.id);
  });
});
