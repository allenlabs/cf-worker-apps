import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { lazyStream } from "@earendil-works/pi-ai/api/lazy";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { codexDiagnostic, codexHtmlError, reportCodexDiagnostic } from "./codex-http.js";

export function installSubscriptionModels(models, credentials, authorize = async () => {}, onDiagnostic) {
  const publicProvider = openaiProvider(), codex = openaiCodexProvider();
  for (const provider of [publicProvider, codex]) {
    provider.auth = { apiKey: { name: "Verified subscription bearer", resolve: async () => {
      await authorize();
      const account = await credentials();
      return { auth: { apiKey: provider.id === "openai-codex" ? (await account.codexAccess()).access : await account.access() }, source: "ChatGPT subscription" };
    } } };
    if (provider.id === "openai-codex") for (const method of ["stream", "streamSimple"]) {
      const stream = provider[method];
      provider[method] = (model, context, options) => {
        let diagnostic;
        const source = stream(model, context, { ...options, transport: "sse", onResponse: async (info, responseModel) => {
          diagnostic = codexDiagnostic("inference", info);
          await reportCodexDiagnostic(onDiagnostic, diagnostic);
          await options?.onResponse?.(info, responseModel);
        } });
        return lazyStream(model, async () => ({
          async *[Symbol.asyncIterator]() {
            try {
              for await (const event of source) {
                if (event.type === "error") {
                  if (codexHtmlError(event.error.errorMessage)) {
                    if (diagnostic?.category !== "upstream_blocked") {
                      diagnostic = { ...codexDiagnostic("inference", { status: diagnostic?.status, headers: { "content-type": "text/html" } }), ...diagnostic, category: "upstream_blocked", contentType: "html" };
                      await reportCodexDiagnostic(onDiagnostic, diagnostic);
                    }
                    const retryable = isRetryableAssistantError(event.error), overflow = isContextOverflow(event.error);
                    event.error.errorMessage = `codex_upstream_blocked${retryable ? ": provider returned error" : ""}${overflow ? ": context length exceeded" : ""}`;
                  }
                  if (diagnostic) event.error.diagnostic = diagnostic;
                }
                yield event;
              }
            } catch { throw new Error("codex_stream_failed"); }
          },
          async result() { try { return await source.result(); } catch { throw new Error("codex_stream_failed"); } }
        }));
      };
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
