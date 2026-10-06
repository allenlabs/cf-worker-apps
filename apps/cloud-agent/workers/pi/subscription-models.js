import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";

export function installSubscriptionModels(models, credentials, authorize = async () => {}) {
  const publicProvider = openaiProvider(), codex = openaiCodexProvider();
  for (const provider of [publicProvider, codex]) {
    provider.auth = { apiKey: { name: "Verified subscription bearer", resolve: async () => {
      await authorize();
      const account = await credentials();
      return { auth: { apiKey: provider.id === "openai-codex" ? (await account.codexAccess()).access : await account.access() }, source: "ChatGPT subscription" };
    } } };
    if (provider.id === "openai-codex") for (const method of ["stream", "streamSimple"]) {
      const stream = provider[method];
      provider[method] = (model, context, options) => stream(model, context, { ...options, transport: "sse" });
    }
    models.setProvider(provider);
  }
}

export async function subscriptionModel(models, credentials, id) {
  const status = await credentials.status();
  if (!status.inferenceReady) throw new Error("account_not_connected");
  const provider = status.provider === "codex" ? "openai-codex" : "openai";
  const model = models.getModel(provider, id);
  if (!model) throw new Error("subscription_model_unavailable");
  return { provider, id };
}
