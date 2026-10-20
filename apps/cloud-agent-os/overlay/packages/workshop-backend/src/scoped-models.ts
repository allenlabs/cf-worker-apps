import { z } from 'zod';
import type { Api, AssistantMessage, Model, ProviderHeaders } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai/utils/event-stream';
import type { AgentProviderCatalog, AgentResource } from '@gadgets/workshop-shared/agent-settings';
import type { ModelHandle } from './ai-models';
import { validateAgentEndpoint } from './agent-settings';

type Provider = Extract<AgentResource, { kind: 'provider' }>;
type ProviderAccess = { resource: Provider; apiToken: string };
type CatalogEntry = AgentProviderCatalog['providers'][number];
export type ScopedModelResolution = {
  providerId: string;
  modelId: string;
  baseUrl: string;
  apiToken: string;
};

const PREFIX = 'scoped-provider/';
const CACHE_MS = 30_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const PAGE_BYTES = 2 * 1024 * 1024;
const TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_PAGES = 100;
const MAX_MODELS = 5000;
// ponytail: one RPC is capped at 1 MiB and retained catalogs at 4 MiB; larger catalogs need a paginated catalog RPC.
const CATALOG_BYTES = 1024 * 1024;
const CACHE_BYTES = 4 * CATALOG_BYTES;
const CAPACITY_ERROR = 'The complete model catalog exceeds the catalog size limit; discovery is incomplete.';
const serializedBytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength;
const identifier = z.string().min(1).max(1024).refine(value => !/[\u0000-\u001f\u007f]/u.test(value));
const pageSchema = z.object({
  object: z.literal('list').optional(),
  data: z.array(z.object({ id: identifier })).max(MAX_MODELS),
  has_more: z.boolean().optional(),
  last_id: identifier.nullish(),
  next_cursor: identifier.nullish(),
  next: z.string().min(1).max(8192).nullish(),
  error: z.unknown().optional(),
}).passthrough();

class CatalogError extends Error {}

export function scopedModelId(providerId: string, modelId: string): string {
  return `${PREFIX}${encodeURIComponent(identifier.parse(providerId))}/${encodeURIComponent(identifier.parse(modelId))}`;
}

export function parseScopedModelId(id: string): { providerId: string; modelId: string } | undefined {
  if (!id.startsWith(PREFIX)) return undefined;
  const parts = id.slice(PREFIX.length).split('/');
  if (parts.length !== 2) throw new Error('Invalid scoped model selection.');
  try {
    const providerId = identifier.parse(decodeURIComponent(parts[0]));
    const modelId = identifier.parse(decodeURIComponent(parts[1]));
    if (scopedModelId(providerId, modelId) !== id) throw new Error();
    return { providerId, modelId };
  } catch {
    throw new Error('Invalid scoped model selection.');
  }
}

export function scopedProviderUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new CatalogError('The provider endpoint is invalid.'); }
  if (!validateAgentEndpoint(value)) {
    throw new CatalogError('The provider endpoint must be a public HTTPS endpoint without credentials, a query, or a fragment.');
  }
  // Native configuration enables global_fetch_strictly_public to preserve public-zone routing.
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

async function readPage(response: Response, remaining: number): Promise<{ value: unknown; bytes: number }> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new CatalogError(`Model discovery failed (HTTP ${response.status}).`);
  }
  const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (type !== 'application/json' && !type?.endsWith('+json')) {
    throw new CatalogError('Model discovery did not return JSON.');
  }
  if (!response.body) throw new CatalogError('Model discovery returned an empty response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > Math.min(PAGE_BYTES, remaining)) {
        await reader.cancel();
        throw new CatalogError('The model catalog exceeds the response size limit; discovery is incomplete.');
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(body)), bytes };
  } catch { throw new CatalogError('Model discovery returned invalid JSON or UTF-8.'); }
}

async function discover(access: ProviderAccess, request: typeof fetch, provider: Provider, remainingModelBytes: number): Promise<string[]> {
  const base = scopedProviderUrl(access.resource.baseUrl);
  const endpoint = new URL(`${base.href.replace(/\/$/, '')}/models`);
  let next: URL | undefined = endpoint;
  const visited = new Set<string>();
  const models = new Set<string>();
  let total = 0;
  let modelBytes = 0;
  const modelOverhead = serializedBytes({
    id: '', providerId: provider.id, modelId: '', name: '',
    providerName: provider.name, scope: provider.scope, source: 'openai-compatible',
  });
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  while (next) {
    if (visited.size >= MAX_PAGES || visited.has(next.href)) {
      throw new CatalogError('Model discovery reached a pagination limit or cycle; the catalog is incomplete.');
    }
    visited.add(next.href);
    const response = await request(next, {
      method: 'GET', redirect: 'manual', signal,
      headers: { Accept: 'application/json', ...(access.apiToken ? { Authorization: `Bearer ${access.apiToken}` } : {}) },
    });
    const body = await readPage(response, TOTAL_BYTES - total);
    total += body.bytes;
    if (typeof body.value === 'object' && body.value !== null && 'data' in body.value &&
        Array.isArray(body.value.data) && body.value.data.length > MAX_MODELS) {
      throw new CatalogError('The model catalog exceeds the model limit; discovery is incomplete.');
    }
    const parsed = pageSchema.safeParse(body.value);
    if (!parsed.success || parsed.data.error !== undefined) {
      throw new CatalogError('Model discovery returned an invalid model list or an error envelope.');
    }
    const page = parsed.data;
    // Unsupported pagination is an explicit error, rather than silently displaying the first page.
    if (['pagination', 'links', 'next_page', 'nextPage', 'nextCursor'].some(key => key in page)) {
      throw new CatalogError('The provider returned an unsupported pagination format; discovery is incomplete.');
    }
    for (const model of page.data) {
      if (access.apiToken && model.id.includes(access.apiToken)) {
        throw new CatalogError('The provider returned an unsafe model identifier.');
      }
      if (!models.has(model.id)) {
        if (models.size >= MAX_MODELS) throw new CatalogError('The model catalog exceeds the model limit; discovery is incomplete.');
        // Count the encoded logical ID and both physical-ID fields before allocating model records.
        modelBytes += modelOverhead + scopedModelId(provider.id, model.id).length +
          2 * (serializedBytes(model.id) - 2) + (models.size ? 1 : 0);
        if (modelBytes > remainingModelBytes) throw new CatalogError(CAPACITY_ERROR);
        models.add(model.id);
      }
    }
    if (page.has_more === false && (page.next || page.next_cursor)) {
      throw new CatalogError('The provider returned conflicting pagination fields.');
    }
    if (page.next) {
      let continuation: URL;
      try { continuation = new URL(page.next, next); } catch { throw new CatalogError('The provider returned an invalid continuation.'); }
      if (continuation.origin !== endpoint.origin || continuation.pathname !== endpoint.pathname ||
          continuation.username || continuation.password || continuation.hash) {
        throw new CatalogError('The provider continuation left the model-list endpoint.');
      }
      next = continuation;
    } else if (page.next_cursor) {
      next = new URL(endpoint);
      next.searchParams.set('cursor', page.next_cursor);
    } else if (page.has_more) {
      const cursor = page.last_id ?? page.data.at(-1)?.id;
      if (!cursor) throw new CatalogError('The provider reported more models without a continuation.');
      next = new URL(endpoint);
      next.searchParams.set('after', cursor);
    } else { next = undefined; }
  }
  return [...models];
}

export function createScopedModelCatalog(options: {
  providerList: () => Promise<AgentResource[]>;
  resolveProvider: (providerId: string) => Promise<ProviderAccess | undefined>;
  fetch?: typeof fetch;
  now?: () => number;
}) {
  const cache = new Map<string, { baseUrl: string; checkedAt: number; entry: CatalogEntry; bytes: number }>();
  let cacheBytes = 0;
  const now = options.now ?? Date.now;
  function forget(id: string) {
    cacheBytes -= cache.get(id)?.bytes ?? 0;
    cache.delete(id);
  }
  function remember(provider: Provider, entry: CatalogEntry) {
    const value = { baseUrl: provider.baseUrl, checkedAt: now(), entry };
    const bytes = serializedBytes(value);
    forget(provider.id);
    if (bytes > CACHE_BYTES) return;
    for (const id of cache.keys()) {
      if (cacheBytes + bytes <= CACHE_BYTES) break;
      forget(id);
    }
    cache.set(provider.id, { ...value, bytes });
    cacheBytes += bytes;
  }
  function present(provider: Provider, entry: CatalogEntry, error = entry.error): CatalogEntry {
    const labeled = { ...entry, name: provider.name, scope: provider.scope, error, models: [] };
    let bytes = serializedBytes(labeled);
    const models: CatalogEntry['models'] = [];
    for (const model of entry.models) {
      const next = { ...model, providerName: provider.name, scope: provider.scope };
      bytes += serializedBytes(next) + (models.length ? 1 : 0);
      if (bytes > CATALOG_BYTES) return { ...labeled, refreshedAt: null, error: CAPACITY_ERROR };
      models.push(next);
    }
    return { ...labeled, models };
  }
  async function providerCatalog(provider: Provider, refresh: boolean): Promise<CatalogEntry> {
    const current = cache.get(provider.id);
    let cached = current?.baseUrl === provider.baseUrl ? current : undefined;
    const empty: CatalogEntry = {
      id: provider.id, name: provider.name, scope: provider.scope, models: [], refreshedAt: null, error: null,
    };
    try {
      const access = await options.resolveProvider(provider.id);
      if (!access || !access.resource.enabled || access.resource.id !== provider.id ||
          access.resource.baseUrl !== provider.baseUrl) {
        cached = undefined;
        throw new CatalogError('Provider access is no longer available.');
      }
      if (!refresh && cached && now() - cached.checkedAt < CACHE_MS) {
        return present(provider, cached.entry);
      }
      const entry: CatalogEntry = { ...empty, refreshedAt: new Date(now()).toISOString() };
      const ids = await discover(access, options.fetch ?? fetch, provider, CATALOG_BYTES - serializedBytes(entry));
      entry.models = ids.map(modelId => ({
        id: scopedModelId(provider.id, modelId), providerId: provider.id, modelId, name: modelId,
        providerName: provider.name, scope: provider.scope, source: 'openai-compatible',
      }));
      remember(provider, entry);
      return entry;
    } catch (error) {
      const entry = present(provider, cached?.entry ?? empty,
        error instanceof CatalogError ? error.message : 'Model discovery failed or timed out.');
      // Preserve a complete same-endpoint cache when a renamed label makes its presentation too large.
      if (entry.error !== CAPACITY_ERROR || entry.models.length || !cached) remember(provider, entry);
      return entry;
    }
  }
  async function catalog(refresh = false): Promise<AgentProviderCatalog> {
    const inventory = await options.providerList().catch(() => { throw new Error('Provider inventory is unavailable.'); });
    const providers = inventory.filter((resource): resource is Provider =>
      resource.kind === 'provider' && resource.enabled);
    const authorized = new Set(providers.map(provider => provider.id));
    for (const id of cache.keys()) if (!authorized.has(id)) forget(id);
    const entries: CatalogEntry[] = providers.map(provider => ({
      id: provider.id, name: provider.name, scope: provider.scope, models: [], refreshedAt: null, error: CAPACITY_ERROR,
    }));
    let bytes = serializedBytes({ providers: entries });
    if (bytes > CATALOG_BYTES) throw new CatalogError(CAPACITY_ERROR);
    for (let start = 0; start < providers.length; start += 4) {
      const batch = await Promise.all(providers.slice(start, start + 4).map(provider => providerCatalog(provider, refresh)));
      for (const [offset, entry] of batch.entries()) {
        const index = start + offset;
        const nextBytes = bytes + serializedBytes(entry) - serializedBytes(entries[index]);
        if (nextBytes <= CATALOG_BYTES) {
          entries[index] = entry;
          bytes = nextBytes;
        }
      }
    }
    return structuredClone({ providers: entries });
  }
  async function resolveScopedModel(id: string): Promise<ScopedModelResolution> {
    const selected = parseScopedModelId(id);
    if (!selected) throw new Error('Invalid scoped model selection.');
    const access = await options.resolveProvider(selected.providerId).catch(() => {
      throw new Error('Provider access is unavailable.');
    });
    if (!access || !access.resource.enabled || access.resource.id !== selected.providerId) {
      throw new Error('Provider access is no longer available.');
    }
    scopedProviderUrl(access.resource.baseUrl);
    const entry = await providerCatalog(access.resource, false);
    if (entry.error || !entry.models.some(model => model.id === id)) {
      throw new Error('The selected model is not available in a complete provider catalog. Refresh the model list.');
    }
    // Re-resolve after discovery so an access revocation while the HTTP request was in flight wins.
    const fresh = await options.resolveProvider(selected.providerId).catch(() => {
      throw new Error('Provider access is unavailable.');
    });
    if (!fresh || !fresh.resource.enabled || fresh.resource.id !== selected.providerId ||
        fresh.resource.baseUrl !== access.resource.baseUrl) throw new Error('Provider access changed. Select the model again.');
    return { ...selected, baseUrl: fresh.resource.baseUrl, apiToken: fresh.apiToken };
  }
  return { catalog, resolveScopedModel };
}

export function scopedModelResolver(authority: {
  getEffectiveAgentResources(userId: string): Promise<AgentResource[]>;
  resolveAgentProvider(userId: string, providerId: string): Promise<ProviderAccess | undefined>;
}, userId: string): (id: string) => Promise<ScopedModelResolution> {
  return createScopedModelCatalog({
    providerList: () => authority.getEffectiveAgentResources(userId),
    resolveProvider: id => authority.resolveAgentProvider(userId, id),
  }).resolveScopedModel;
}

type DirectHandleFactory = (args: {
  model: Model<Api>; apiKey: string; headers?: ProviderHeaders; sessionAffinity?: string; fetch?: typeof fetch;
}) => ModelHandle;

function descriptor(providerId: string, modelId: string, baseUrl: string): Model<Api> {
  return {
    id: modelId, name: modelId, api: 'openai-completions', provider: `scoped:${providerId}`, baseUrl,
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // /models does not advertise token limits or prices. Use the native unknown-model limits.
    contextWindow: 128_000, maxTokens: 4096,
    compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false,
      supportsLongCacheRetention: false,
      maxTokensField: new URL(baseUrl).origin === 'https://api.openai.com' ? 'max_completion_tokens' : 'max_tokens' },
  };
}

export function createScopedModelHandle(options: {
  id: string;
  resolveScopedModel: () => Promise<ScopedModelResolution>;
  makeHandle: DirectHandleFactory;
  sessionAffinity?: string;
}): ModelHandle {
  const selected = parseScopedModelId(options.id);
  if (!selected) throw new Error('Invalid scoped model selection.');
  const handle: ModelHandle = {
    model: descriptor(selected.providerId, selected.modelId, 'https://provider.invalid'),
    stream: (_model, context, streamOptions = {}) => {
      handle.lastResponse = undefined;
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          const resolved = await options.resolveScopedModel();
          if (resolved.providerId !== selected.providerId || resolved.modelId !== selected.modelId) throw new Error();
          const endpoint = scopedProviderUrl(resolved.baseUrl);
          if (streamOptions.signal?.aborted) throw new Error();
          const model = descriptor(resolved.providerId, resolved.modelId, endpoint.href.replace(/\/$/, ''));
          const { fetch: request = fetch, ...rest } = streamOptions;
          const guardedFetch: typeof fetch = async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : input.toString());
            if (url.origin !== endpoint.origin || url.pathname !== `${endpoint.pathname.replace(/\/$/, '')}/chat/completions` ||
                url.username || url.password || url.hash) throw new Error('The provider request left its configured endpoint.');
            const response = await request(input, { ...init, redirect: 'manual' });
            if (response.status >= 300 && response.status < 400) throw new Error('Provider redirects are not permitted.');
            return response;
          };
          const direct = options.makeHandle({ model, apiKey: resolved.apiToken || 'unused',
            ...(resolved.apiToken ? {} : { headers: { Authorization: null } }),
            fetch: guardedFetch, sessionAffinity: options.sessionAffinity });
          const stream = direct.stream(model, context, rest);
          let terminal = false;
          for await (const event of stream) {
            handle.lastResponse = direct.lastResponse;
            terminal ||= event.type === 'done' || event.type === 'error';
            output.push(event.type === 'error'
              ? { ...event, error: { ...event.error, content: [], errorMessage: 'Scoped provider inference failed.' } }
              : event);
          }
          if (!terminal) throw new Error();
          output.end();
        } catch {
          const error: AssistantMessage = {
            role: 'assistant', content: [], api: 'openai-completions', provider: `scoped:${selected.providerId}`,
            model: selected.modelId, stopReason: streamOptions.signal?.aborted ? 'aborted' : 'error',
            errorMessage: 'Scoped provider access or inference is unavailable. Refresh the model list and check permissions.',
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now(),
          };
          output.push({ type: 'error', reason: error.stopReason === 'aborted' ? 'aborted' : 'error', error });
          output.end();
        }
      })();
      return output;
    },
  };
  return handle;
}
