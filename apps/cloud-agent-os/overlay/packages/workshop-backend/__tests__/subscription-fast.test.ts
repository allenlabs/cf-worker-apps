import { env } from 'cloudflare:workers';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { describe, expect, it } from 'vitest';
import { SubscriptionModels, readSubscriptionConnections } from '../src/subscription-models';
import { DEFAULT_ADMIN_CONFIG } from '../src/storage-schema/admin-settings-storage';
import { cloudAgentModel } from '../src/cloud-agent-model';

const userId = 'fast-catalog@example.invalid', defaultModel = 'gpt-6.1-sol';
const extraModel = Object.values(OPENAI_MODELS).find(model => model.id !== defaultModel)!;
const connection = { id: 'owner', label: 'Synthetic subscription', provider: 'siwc' as const, ready: true };
const extraId = `subscription-model:owner:siwc:${extraModel.id}`;
function deployment(models: unknown[], provider: 'siwc' | 'codex' = 'siwc', legacy = false) {
  const row = { ...connection, provider };
  return { ...env, CODEX_BRIDGE_MANAGEMENT: 'admin', CODEX_BRIDGE_SETUP: 'siwc',
    CODEX_BRIDGE_MODEL: defaultModel, CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([userId]),
    CODEX_BRIDGE: {
      async subscriptionConnections() { return [row]; },
      async subscriptionModels() { return legacy
        ? { source: 'bundled-provider-catalog', entitlementVerified: false, connections: [{ ...row, models }] }
        : { source: 'subscription-provider-catalog', connections: [{ ...row, models,
          source: provider === 'siwc' ? 'provider-account-catalog' : 'bundled-provider-catalog',
          entitlementVerified: provider === 'siwc' }] }; },
    },
  };
}
async function catalog(models: unknown[], provider: 'siwc' | 'codex' = 'siwc', legacy = false) {
  const selected = deployment(models, provider, legacy);
  return new SubscriptionModels(selected, DEFAULT_ADMIN_CONFIG, userId, await readSubscriptionConnections(selected));
}

describe('per-model subscription Fast capability', () => {
  it('projects the physical default and extra capabilities independently into current profiles', async () => {
    const selected = await catalog([
      { id: defaultModel, name: 'Default', supportsFast: false },
      { id: extraModel.id, name: 'Extra', supportsFast: true },
    ]);
    expect(selected.get(defaultModel)?.supportsFast).not.toBe(true);
    expect(selected.get(extraId)?.supportsFast).toBe(true);
    expect(selected.list().find(model => model.id === extraId)?.supportsFast).toBe(true);
    expect(selected.resolve(extraId)?.profile.supportsFast).toBe(true);
    expect(selected.resolve(defaultModel)?.profile.supportsFast).not.toBe(true);
    expect(selected.providerCatalog().providers[0].models.find(model => model.id === extraId)?.supportsFast).toBe(true);
    expect(selected.resolve(extraId)?.config).not.toHaveProperty('supportsFast');
    const reversed = await catalog([
      { id: defaultModel, name: 'Default', supportsFast: true },
      { id: extraModel.id, name: 'Extra', supportsFast: false },
    ]);
    expect(reversed.resolve(defaultModel)?.profile.supportsFast).toBe(true);
    expect(reversed.resolve(extraId)?.profile.supportsFast).not.toBe(true);
  });

  it('leaves old metadata, legacy and Codex catalogs unsupported', async () => {
    const plain = [{ id: defaultModel, name: 'Default' }];
    expect((await catalog(plain)).resolve(defaultModel)?.profile.supportsFast).not.toBe(true);
    for (const [provider, legacy] of [['siwc', true], ['codex', false]] as const) {
      expect((await catalog([{ ...plain[0], supportsFast: true }], provider, legacy))
        .resolve(defaultModel)?.profile.supportsFast).not.toBe(true);
    }
    const selected = deployment(plain);
    delete (selected.CODEX_BRIDGE as Partial<typeof selected.CODEX_BRIDGE>).subscriptionModels;
    const noMetadata = new SubscriptionModels(selected, DEFAULT_ADMIN_CONFIG, userId,
      await readSubscriptionConnections(selected));
    expect(noMetadata.resolve(defaultModel)?.profile.supportsFast).not.toBe(true);
  });

  it('rejects non-boolean Fast metadata at the private boundary', async () => {
    await expect(catalog([{ id: defaultModel, name: 'Default', supportsFast: 'priority' }])).rejects.toThrow();
  });
});

describe('Fast bridge request and response metadata', () => {
  it('requests priority only for an opted-in stable model handle and preserves the delivered tier', async () => {
    const requests: any[] = [];
    const message = { role: 'assistant', content: [{ type: 'text', text: 'Synthetic answer' }],
      api: 'openai-responses', provider: 'openai', model: defaultModel,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: 0 };
    const selected = { ...deployment([]), CODEX_BRIDGE: {
      async infer(request: unknown) {
        requests.push(request);
        return { stream: new ReadableStream<Uint8Array>({ start(controller) {
          for (const event of [{ type: 'start', partial: { ...message, responseServiceTier: 'ultrafast' } },
            { type: 'done', reason: 'stop', message: { ...message, responseServiceTier: 'default' } }])
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ version: 1, event }) + '\n'));
          controller.close();
        } }), cancellation: { async cancel() {}, [Symbol.dispose]() {} } };
      },
    } };
    const config = { provider: 'openai' as const, model: defaultModel, apiToken: '', transport: 'subscription' as const,
      subscriptionProvider: 'siwc' as const, subscriptionAccountId: 'owner', reasoning: 'high' as const };
    const user = { type: 'user' as const, id: userId, name: 'Synthetic user' };
    for (const fastMode of [undefined, false, true]) {
      const routing = { fastMode };
      const handle = cloudAgentModel(selected, config, user, routing)!;
      routing.fastMode = !fastMode;
      for (let step = 0; step < 2; step++) {
        const stream = handle.stream(handle.model, { messages: [] });
        for await (const event of stream) {
          if (event.type === 'start') expect(event.partial).not.toHaveProperty('responseServiceTier');
        }
        const result = await stream.result();
        expect(result).toHaveProperty('responseServiceTier', 'default');
        expect(requests.at(-1).options).toEqual({ reasoning: 'high', maxTokens: 4096,
          ...(fastMode ? { serviceTier: 'priority' } : {}) });
      }
    }
    expect(requests).toHaveLength(6);
  });
});
