import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { OPENAI_MODELS } from '@earendil-works/pi-ai/providers/openai.models';
import { describe, expect, it } from 'vitest';
import { LanguageModelGatekeeper } from '../src/ai-models';
import { AdminSettings } from '../src/admin-settings';
import { DEFAULT_ADMIN_CONFIG } from '../src/storage-schema/admin-settings-storage';
import { readSubscriptionConnections, SubscriptionModels } from '../src/subscription-models';
import './test-worker';

const userId = 'binding-catalog@example.invalid', defaultModel = 'gpt-6.1-sol';
const connection = { id: 'owner', label: 'Synthetic subscription', provider: 'siwc' as const, ready: true };
const physical = Object.values(OPENAI_MODELS).find(model => model.id !== defaultModel)!;
const selectedId = `subscription-model:owner:siwc:${physical.id}`;
const inputs: unknown[] = [];
const deployment = { ...env, CODEX_BRIDGE_MANAGEMENT: 'admin', CODEX_BRIDGE_SETUP: 'siwc',
  CODEX_BRIDGE_MODEL: defaultModel, CODEX_BRIDGE_ALLOWED_USER_IDS: JSON.stringify([userId]),
  CODEX_BRIDGE: {
    async subscriptionConnections() { return [connection]; },
    async subscriptionModels() { return { source: 'bundled-provider-catalog', entitlementVerified: false,
      connections: [{ ...connection, models: Object.values(OPENAI_MODELS).map(({ id, name }) => ({ id, name })) }] }; },
    async infer(input: unknown) { inputs.push(input); throw new Error('Synthetic inference stopped'); },
  },
};
async function setModes(modelModes: Record<string, 'disabled'>) {
  await runInDurableObject(env.TEST_ADMIN_SETTINGS.getByName(''), async (_host, state) => {
    const admin = new AdminSettings(state, { ...env, BLUEPRINTS: { put: async () => {} } } as unknown as Cloudflare.Env);
    await admin.updateAdminConfig({ ...DEFAULT_ADMIN_CONFIG, modelModes });
  });
}

describe('subscription physical models in stored gadget bindings', () => {
  it('revalidates the complete model catalog, preserves the selected transport and rejects current disabling', async () => {
    await setModes({});
    const models = new SubscriptionModels(deployment, DEFAULT_ADMIN_CONFIG, userId, await readSubscriptionConnections(deployment));
    const record = models.resolve(selectedId)!;
    expect(record.config.model).toBe(physical.id);
    expect(models.all.some(model => model.id === selectedId)).toBe(false);
    await runInDurableObject(env.TEST_USER_DIRECTORY.getByName('subscription-physical-binding'), async (_host, state) => {
      Object.defineProperty(state, 'props', { configurable: true, value: {
        displayName: record.profile.name, config: record.config,
        initiator: { type: 'gadget', id: userId, name: 'Synthetic workspace' },
      } });
      const gatekeeper = new LanguageModelGatekeeper(state, deployment);
      const binding = await gatekeeper.startSession(undefined!);
      await expect(binding.run({ prompt: 'Synthetic no-network call' })).rejects.toThrow();
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toMatchObject({ userId, subscriptionAccountId: 'owner', modelId: physical.id });
      await setModes({ [selectedId]: 'disabled' });
      await expect(gatekeeper.startSession(undefined!)).rejects.toThrow('disabled');
      expect(inputs).toHaveLength(1);
    });
  });
});
