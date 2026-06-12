// Regression test for the client-side SPA navigation hang.
//
// Bug: the root route's `beforeLoad`/`loader` run on BOTH the server (SSR)
// and the client (every in-app <Link> navigation). They call server-only
// helpers (`getRequest`, `getEnv`, `verifySessionToken`, `getCurrentUser`)
// which the vite build replaces with import-protection *mock proxies* in the
// client bundle (we run import-protection with `behavior: 'mock'`). A mock
// proxy is callable, never throws, and — critically — `await`-ing one never
// settles. The old code assumed `getRequest()` would THROW on the client and
// guarded it with try/catch; the mock does NOT throw, so execution fell
// through to `await verifySessionToken(<mock>)`, which hung the root
// `beforeLoad` forever. `router.load()` never resolved, the matched route's
// loader never ran, and clicking any <Link> "did nothing" (URL changed via
// pushState, but the route never rendered).
//
// The fix: bail out of `beforeLoad`/`loader` up front on the client
// (`typeof document !== 'undefined'`) before touching any server-only helper.
//
// This test reproduces the failure mode by mocking those modules with
// NEVER-RESOLVING mock proxies (exactly what awaiting a real mock proxy does).
// Under jsdom `document` is defined, so the fixed code must resolve WITHOUT
// awaiting any of them. The pre-fix code awaits the never-resolving mock and
// would time out here.
import { describe, expect, it, vi } from 'vitest';

// A thenable that never resolves — modelling `await <import-protection mock>`.
const neverResolves = () =>
  ({
    then: () => {
      /* intentionally never calls back */
    },
  }) as unknown as Promise<never>;

const callTracker = { getRequest: 0, getEnv: 0, getCurrentUser: 0, verifySessionToken: 0, readSessionToken: 0 };

vi.mock('@tanstack/react-start/server', () => ({
  getRequest: () => {
    callTracker.getRequest++;
    // Return a truthy mock proxy (this is what the client build does — it does
    // NOT throw, which is the whole reason the old try/catch guard failed).
    return { headers: { get: () => 'mock' }, url: 'mock' } as unknown;
  },
}));

vi.mock('~/server/auth-runtime.server', () => ({
  getEnv: () => {
    callTracker.getEnv++;
    return { APP_NAME: 'mock' } as unknown;
  },
  getCurrentUser: () => {
    callTracker.getCurrentUser++;
    return neverResolves();
  },
}));

vi.mock('@allenlabs/pm-core/server/session.server', () => ({
  readSessionToken: () => {
    callTracker.readSessionToken++;
    return 'mock-token';
  },
  verifySessionToken: () => {
    callTracker.verifySessionToken++;
    return neverResolves();
  },
}));

// Stylesheet url import resolves to a string at build time; stub it.
vi.mock('~/styles/app.css?url', () => ({ default: '/assets/app.css' }));

describe('root route client-side navigation guard', () => {
  it('beforeLoad resolves on the client without touching server-only helpers', async () => {
    expect(typeof document).not.toBe('undefined'); // jsdom: this is the "client"
    const { Route } = await import('~/routes/__root');
    const beforeLoad = Route.options.beforeLoad as () => Promise<unknown>;

    // Must settle promptly. Pre-fix this awaited a never-resolving mock proxy.
    const result = await Promise.race([
      beforeLoad().then(() => 'resolved'),
      new Promise((res) => setTimeout(() => res('TIMED_OUT'), 1000)),
    ]);

    expect(result).toBe('resolved');
    // The client path must NOT have entered the server-only auth logic.
    expect(callTracker.verifySessionToken).toBe(0);
    expect(callTracker.getEnv).toBe(0);
  });

  it('loader resolves on the client and returns the static layout default', async () => {
    const { Route } = await import('~/routes/__root');
    const loader = Route.options.loader as () => Promise<{ user: unknown; appName: string }>;

    const result = await Promise.race([
      loader(),
      new Promise((res) => setTimeout(() => res('TIMED_OUT'), 1000)),
    ]);

    expect(result).not.toBe('TIMED_OUT');
    expect(result).toMatchObject({ user: null, appName: 'Project Management' });
    expect(callTracker.verifySessionToken).toBe(0);
  });
});
