import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { stream as completionsStream } from '@earendil-works/pi-ai/api/openai-completions';
import type { AgentResource } from '@gadgets/workshop-shared/agent-settings';
import { getModel } from '../src/ai-models';
import {
  createScopedModelCatalog, createScopedModelHandle, parseScopedModelId, scopedModelId,
  scopedProviderUrl, type ScopedModelResolution,
} from '../src/scoped-models';

type Provider = Extract<AgentResource, { kind: 'provider' }>;
const provider: Provider = {
  id: 'provider-one', kind: 'provider', name: 'Organization router', scope: { kind: 'organization' },
  enabled: true, baseUrl: 'https://models.example.com/v1',
};
const token = 'synthetic-private-token';
function requestWith(handler: (request: Request) => Promise<Response> | Response): typeof fetch {
  return async (input, init) => handler(new Request(input, init));
}
function setup(request: typeof fetch, providers = [provider]) {
  const state = { providers, allowed: true, now: 0 };
  const catalog = createScopedModelCatalog({
    providerList: async () => state.providers,
    resolveProvider: async id => {
      const resource = state.providers.find(value => value.id === id);
      return resource && state.allowed ? { resource, apiToken: token } : undefined;
    }, fetch: request, now: () => state.now,
  });
  return { state, ...catalog };
}

describe('scoped provider catalog', () => {
  it('loads every advertised model across pages, retaining physical IDs and unique provider IDs', async () => {
    const seen: Request[] = [];
    const service = setup(requestWith(request => {
      seen.push(request);
      const after = new URL(request.url).searchParams.get('after');
      return Response.json({ object: 'list', data: Array.from({ length: 101 }, (_, index) => ({
        id: `${after ? 'page-two' : 'page-one'}/${index}:模型`,
      })), has_more: !after, last_id: after ? null : 'physical-cursor' });
    }), [provider, { ...provider, id: 'provider-two' }]);
    const result = await service.catalog();
    expect(result.providers.map(value => value.models.length)).toEqual([202, 202]);
    expect(new Set(result.providers.flatMap(value => value.models.map(model => model.id))).size).toBe(404);
    expect(result.providers[0].models[0].modelId).toBe('page-one/0:模型');
    expect(result.providers[0].error).toBeNull();
    expect(seen).toHaveLength(4);
    expect(seen[0].method).toBe('GET');
    expect(seen[0].redirect).toBe('manual');
    expect(seen[0].headers.get('authorization')).toBe(`Bearer ${token}`);
    expect(seen.filter(request => new URL(request.url).searchParams.get('after') === 'physical-cursor')).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('follows explicit same-endpoint continuations and cursor pages to completion', async () => {
    const service = setup(requestWith(request => {
      const url = new URL(request.url);
      if (url.searchParams.get('cursor')) return Response.json({ data: [{ id: 'third' }], has_more: false });
      if (url.search) return Response.json({ data: [{ id: 'second' }], next_cursor: 'cursor-two' });
      return Response.json({ data: [{ id: 'first' }], next: '?page=two' });
    }));
    expect((await service.catalog()).providers[0].models.map(model => model.modelId)).toEqual(['first', 'second', 'third']);
  });

  it('deduplicates physical models without treating inherited names as lookup entries', async () => {
    const service = setup(requestWith(() => Response.json({ data: [{ id: 'constructor' }, { id: '__proto__' }, { id: 'constructor' }] })));
    expect((await service.catalog()).providers[0].models.map(model => model.modelId)).toEqual(['constructor', '__proto__']);
  });

  it('uses a bounded cache and labels stale data explicitly after refresh failure', async () => {
    let failed = false;
    const request = vi.fn(requestWith(() => failed
      ? Response.json({ error: { message: token } }, { status: 401 })
      : Response.json({ data: [{ id: 'model-a' }] })));
    const service = setup(request);
    const first = await service.catalog();
    failed = true;
    service.state.now = 1;
    expect((await service.catalog()).providers[0].error).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
    service.state.now = 30_001;
    const stale = await service.catalog();
    expect(stale.providers[0].models).toEqual(first.providers[0].models);
    expect(stale.providers[0].refreshedAt).toBe(first.providers[0].refreshedAt);
    expect(stale.providers[0].error).toContain('HTTP 401');
    expect(JSON.stringify(stale)).not.toContain(token);
    await expect(service.resolveScopedModel(scopedModelId(provider.id, 'model-a'))).rejects.toThrow('complete provider catalog');
  });

  it('bounds expanded model records while preserving a complete same-endpoint cache on capacity failure', async () => {
    const longId = '界'.repeat(1024);
    let oversized = false;
    const service = setup(requestWith(() => Response.json({ data: oversized
      ? Array.from({ length: 400 }, (_, index) => ({ id: `${'界'.repeat(1020)}${String(index).padStart(4, '0')}` }))
      : [{ id: longId }] })));
    const first = await service.catalog();
    expect(first.providers[0].models[0].modelId).toBe(longId);
    expect(first.providers[0].error).toBeNull();
    oversized = true;
    const failed = await service.catalog(true);
    expect(failed.providers[0].models).toEqual(first.providers[0].models);
    expect(failed.providers[0].refreshedAt).toBe(first.providers[0].refreshedAt);
    expect(failed.providers[0].error).toContain('catalog size limit');
    expect(JSON.stringify(failed)).not.toContain(token);
    await expect(service.resolveScopedModel(scopedModelId(provider.id, longId))).rejects.toThrow('complete provider catalog');
  });

  it('rejects model counts beyond the explicit per-provider capacity without returning a partial list', async () => {
    const result = await setup(requestWith(() => Response.json({
      data: Array.from({ length: 5001 }, (_, index) => ({ id: `model-${index}` })),
    }))).catalog();
    expect(result.providers[0].models).toEqual([]);
    expect(result.providers[0].refreshedAt).toBeNull();
    expect(result.providers[0].error).toContain('model limit');
  });

  it('bounds the aggregate RPC catalog and reports every omitted provider as incomplete', async () => {
    const providers = Array.from({ length: 500 }, (_, index) => ({ ...provider, id: `provider-${index}` }));
    const ids = Array.from({ length: 100 }, (_, index) => ({ id: `${'m'.repeat(64)}-${index}` }));
    const result = await setup(requestWith(() => Response.json({ data: ids })), providers).catalog();
    expect(new TextEncoder().encode(JSON.stringify(result)).byteLength).toBeLessThanOrEqual(1024 * 1024);
    expect(result.providers).toHaveLength(500);
    expect(result.providers.some(value => value.models.length === ids.length && value.error === null)).toBe(true);
    expect(result.providers.some(value => value.error?.includes('catalog size limit'))).toBe(true);
    for (const value of result.providers) {
      if (value.error) {
        expect(value.models).toEqual([]);
        expect(value.refreshedAt).toBeNull();
      } else expect(value.models).toHaveLength(ids.length);
    }
  });

  it('evicts older complete caches when retaining them would exceed the shared byte budget', async () => {
    const providers = Array.from({ length: 8 }, (_, index) => ({ ...provider, id: `provider-${index}` }));
    const ids = Array.from({ length: 1000 }, (_, index) => ({ id: `${'m'.repeat(200)}-${index}` }));
    const request = vi.fn(requestWith(() => Response.json({ data: ids })));
    const service = setup(request, providers);
    await service.catalog();
    expect(request).toHaveBeenCalledTimes(providers.length);
    await service.resolveScopedModel(scopedModelId(providers[7].id, ids[0].id));
    expect(request).toHaveBeenCalledTimes(providers.length);
    await service.resolveScopedModel(scopedModelId(providers[0].id, ids[0].id));
    expect(request).toHaveBeenCalledTimes(providers.length + 1);
  });

  it('bounds cached label expansion and keeps the complete cache for a later smaller label', async () => {
    const named = { ...provider, id: 'p', name: 'P' };
    const ids = Array.from({ length: 4500 }, (_, index) => ({ id: `m-${index}` }));
    const request = vi.fn(requestWith(() => Response.json({ data: ids })));
    const service = setup(request, [named]);
    const first = await service.catalog();
    expect(first.providers[0].models).toHaveLength(ids.length);
    service.state.providers = [{ ...named, name: 'N'.repeat(120) }];
    const renamed = await service.catalog();
    expect(renamed.providers[0].models).toEqual([]);
    expect(renamed.providers[0].error).toContain('catalog size limit');
    service.state.providers = [named];
    expect((await service.catalog()).providers[0].models).toEqual(first.providers[0].models);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('never uses cached models after access revocation or endpoint replacement', async () => {
    const service = setup(requestWith(() => Response.json({ data: [{ id: 'model-a' }] })));
    await service.catalog();
    service.state.allowed = false;
    const revoked = await service.catalog();
    expect(revoked.providers[0].models).toEqual([]);
    await expect(service.resolveScopedModel(scopedModelId(provider.id, 'model-a'))).rejects.toThrow('no longer available');
    service.state.providers = [];
    expect((await service.catalog()).providers).toEqual([]);
    service.state.allowed = true;
    service.state.providers = [{ ...provider, baseUrl: 'http://unsafe.example.com/v1' }];
    expect((await service.catalog()).providers[0].models).toEqual([]);
  });

  it.each([
    { body: { data: [{ id: 12 }] }, error: 'invalid model list' },
    { body: { data: [{ id: 'a' }], error: { message: token } }, error: 'error envelope' },
    { body: { data: [], has_more: true }, error: 'without a continuation' },
    { body: { data: [], next: 'https://other.example.com/v1/models' }, error: 'left the model-list endpoint' },
    { body: { data: [], next: '/v1/secret' }, error: 'left the model-list endpoint' },
    { body: { data: [], next: '?page=1', has_more: false }, error: 'conflicting pagination' },
    { body: { data: [], links: { next: '?page=2' } }, error: 'unsupported pagination' },
    { body: { data: [{ id: token }] }, error: 'unsafe model identifier' },
  ])('rejects incomplete or unsafe model discovery: $error', async ({ body, error }) => {
    const service = setup(requestWith(() => Response.json(body)));
    const result = await service.catalog();
    expect(result.providers[0].models).toEqual([]);
    expect(result.providers[0].refreshedAt).toBeNull();
    expect(result.providers[0].error).toContain(error);
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('rejects cursor cycles rather than claiming the first page is complete', async () => {
    const request = vi.fn(requestWith(() => Response.json({ data: [{ id: 'a' }], next_cursor: 'same' })));
    const result = await setup(request).catalog();
    expect(request).toHaveBeenCalledTimes(2);
    expect(result.providers[0].error).toContain('pagination limit or cycle');
    expect(result.providers[0].models).toEqual([]);
  });

  it('stops a changing continuation after the page budget', async () => {
    let page = 0;
    const request = vi.fn(requestWith(() => Response.json({ data: [{ id: `model-${page}` }], next_cursor: `cursor-${++page}` })));
    const result = await setup(request).catalog();
    expect(request).toHaveBeenCalledTimes(100);
    expect(result.providers[0].error).toContain('pagination limit');
  });

  it('rejects oversized, malformed, non-JSON and provider-thrown responses without exposing secrets', async () => {
    for (const request of [
      requestWith(() => new Response(' '.repeat(2 * 1024 * 1024 + 1), { headers: { 'content-type': 'application/json' } })),
      requestWith(() => new Response('{broken', { headers: { 'content-type': 'application/json' } })),
      requestWith(() => new Response(token, { headers: { 'content-type': 'text/plain' } })),
      requestWith(() => { throw new Error(token); }),
    ]) {
      const result = await setup(request).catalog();
      expect(result.providers[0].error).toBeTruthy();
      expect(result.providers[0].models).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(token);
    }
  });

  it('rejects HTTP redirects without forwarding credentials to the target', async () => {
    const request = vi.fn(requestWith(() => new Response(null, { status: 302, headers: { location: 'https://other.example.com/models' } })));
    const result = await setup(request).catalog();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.providers[0].error).toContain('HTTP 302');
  });

  it('supports keyless backends and refreshes cached provider labels', async () => {
    let named = provider;
    const service = createScopedModelCatalog({
      providerList: async () => [named],
      resolveProvider: async () => ({ resource: named, apiToken: '' }),
      fetch: requestWith(request => {
        expect(request.headers.has('authorization')).toBe(false);
        return Response.json({ data: [{ id: 'model-a' }] });
      }),
    });
    await service.catalog();
    named = { ...named, name: 'Renamed organization router' };
    expect((await service.catalog()).providers[0].models[0].providerName).toBe(named.name);
  });

  it('does not expose resolver error details through model selection', async () => {
    const service = createScopedModelCatalog({ providerList: async () => [provider],
      resolveProvider: async () => { throw new Error(token); } });
    await expect(service.resolveScopedModel(scopedModelId(provider.id, 'model-a'))).rejects.toThrow('Provider access is unavailable.');
  });

  it.each(['http://models.example.com', 'https://user:password@models.example.com', 'https://models.example.com?key=value',
    'https://models.example.com/#secret', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1',
    'https://models.internal/v1', 'https://models.example.com:8443/v1'])('rejects disallowed endpoints: %s', baseUrl => {
    expect(() => scopedProviderUrl(baseUrl)).toThrow();
  });

  it('rejects unknown selections and revocation during discovery', async () => {
    const service = setup(requestWith(() => Response.json({ data: [{ id: 'known' }] })));
    await expect(service.resolveScopedModel(scopedModelId(provider.id, 'unknown'))).rejects.toThrow('not available');
    const delayed = setup(requestWith(() => {
      delayed.state.allowed = false;
      return Response.json({ data: [{ id: 'known' }] });
    }));
    await expect(delayed.resolveScopedModel(scopedModelId(provider.id, 'known'))).rejects.toThrow('access changed');
  });

  it('encodes logical IDs reversibly without colliding with subscription and personal model IDs', () => {
    const encoded = scopedModelId('provider-one', 'vendor/model:日本語%');
    expect(parseScopedModelId(encoded)).toEqual({ providerId: 'provider-one', modelId: 'vendor/model:日本語%' });
    expect(parseScopedModelId('my-personal-model')).toBeUndefined();
    expect(() => parseScopedModelId('scoped-provider/a/%ZZ')).toThrow('Invalid scoped model');
    expect(() => parseScopedModelId('scoped-provider/a/%61')).toThrow('Invalid scoped model');
  });
});

describe('scoped provider inference', () => {
  function handle(resolveScopedModel: () => Promise<ScopedModelResolution>) {
    return createScopedModelHandle({
      id: scopedModelId(provider.id, 'new/custom-model'), resolveScopedModel,
      makeHandle: args => ({ model: args.model,
        stream: (model, context, options) => completionsStream({ ...model, api: 'openai-completions' }, context, {
          ...options, apiKey: args.apiKey, headers: args.headers, fetch: args.fetch,
        }),
      }),
    });
  }
  const context = { messages: [{ role: 'user' as const, content: 'hello', timestamp: 0 }] };
  const resolution = { providerId: provider.id, modelId: 'new/custom-model', baseUrl: provider.baseUrl, apiToken: token };

  it.each([
    { baseUrl: 'https://api.openai.com/v1', modelId: 'o3', field: 'max_completion_tokens' },
    { baseUrl: 'https://api.openai.com:443/v1/', modelId: 'o4-mini', field: 'max_completion_tokens' },
    { baseUrl: provider.baseUrl, modelId: 'o3', field: 'max_tokens' },
    { baseUrl: 'https://api.openai.com.example.com/v1', modelId: 'o3', field: 'max_tokens' },
    { baseUrl: 'https://models.example.com/api.openai.com/v1', modelId: 'o3', field: 'max_tokens' },
  ])('sends $field through the actual scoped model handle for $baseUrl', async ({ baseUrl, modelId, field }) => {
    const model = getModel(env,
      { provider: 'openai', model: modelId, apiToken: '', transport: 'scoped', scopedProviderId: provider.id },
      { type: 'user', id: 'synthetic-user@example.invalid', name: 'Synthetic user' },
      { resolveScopedModel: async () => ({ ...resolution, modelId, baseUrl }) });
    const requests: Request[] = [];
    const request = requestWith(value => {
      requests.push(value);
      const chunks = [
        { id: 'synthetic-completion', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] },
        { id: 'synthetic-completion', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ];
      return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } });
    });
    const result = await model.stream(model.model, context, { fetch: request, maxTokens: 123, maxRetries: 0 }).result();
    expect(result.stopReason).toBe('stop');
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(`${new URL(baseUrl).href.replace(/\/$/, '')}/chat/completions`);
    expect(requests[0].headers.get('authorization')).toBe(`Bearer ${token}`);
    const body = await requests[0].json();
    expect(body).toMatchObject({ model: modelId, [field]: 123 });
    expect(body).not.toHaveProperty(field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens');
  });

  it('uses completions for unknown physical IDs and refreshes endpoint and credentials on every stream', async () => {
    let current = resolution;
    const resolve = vi.fn(async () => current);
    const model = handle(resolve);
    const requests: Request[] = [];
    const request = requestWith(value => {
      requests.push(value);
      return Response.json({ error: { message: token } }, { status: 400 });
    });
    for (const baseUrl of [provider.baseUrl, 'https://second.example.com/api']) {
      current = { ...current, baseUrl, apiToken: `${token}-${requests.length}` };
      const result = await model.stream(model.model, context, { fetch: request, maxRetries: 0 }).result();
      expect(result.stopReason).toBe('error');
      expect(JSON.stringify(result)).not.toContain(token);
      expect(requests.at(-1)?.url).toBe(`${baseUrl}/chat/completions`);
      expect(requests.at(-1)?.headers.get('authorization')).toBe(`Bearer ${current.apiToken}`);
      expect(requests.at(-1)?.redirect).toBe('manual');
      expect(await requests.at(-1)?.json()).toMatchObject({ model: 'new/custom-model' });
    }
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it('rejects a previously selected model after access is revoked without any inference request', async () => {
    let allowed = true;
    const model = handle(async () => { if (!allowed) throw new Error(token); return resolution; });
    const request = vi.fn(requestWith(() => Response.json({ error: { message: 'synthetic' } }, { status: 400 })));
    await model.stream(model.model, context, { fetch: request, maxRetries: 0 }).result();
    allowed = false;
    const result = await model.stream(model.model, context, { fetch: request, maxRetries: 0 }).result();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('error');
    expect(result.errorMessage).toContain('permissions');
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('does not send credentials to a substituted source or endpoint', async () => {
    const request = vi.fn(requestWith(() => Response.json({})));
    for (const changed of [{ ...resolution, providerId: 'provider-two' }, { ...resolution, baseUrl: 'http://unsafe.example.com/v1' }]) {
      const model = handle(async () => changed);
      expect((await model.stream(model.model, context, { fetch: request }).result()).stopReason).toBe('error');
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects inference redirects and returns a safe terminal error', async () => {
    const model = handle(async () => resolution);
    const request = vi.fn(requestWith(() => new Response(null, { status: 307, headers: { location: 'https://other.example.com/chat/completions' } })));
    const result = await model.stream(model.model, context, { fetch: request, maxRetries: 0 }).result();
    expect(request).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe('error');
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
