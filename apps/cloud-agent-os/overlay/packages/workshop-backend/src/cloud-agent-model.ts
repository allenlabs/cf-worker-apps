import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type { AssistantMessage, AssistantMessageEvent, Context, Model, Api } from "@earendil-works/pi-ai";
import type { AiChatAuthorInfo, AiModelConfig } from "@gadgets/workshop-shared/api";
import type { ModelHandle, ModelStreamOptions } from "./ai-models";
import { z } from "zod";

type BridgeEnvironment = {
  CODEX_BRIDGE?: { infer(input: unknown): Promise<{ stream: ReadableStream<Uint8Array>; cancellation: { cancel(): Promise<void>; [Symbol.dispose](): void } }> };
  CODEX_BRIDGE_MODEL?: string;
  CODEX_BRIDGE_ALLOWED_USER_IDS?: string;
};

const limit = 1048576, frameLimit = 524288, outputLimit = 8388608;
const encoder = new TextEncoder();
const text = z.string().max(262144);
const counter = z.number().int().nonnegative();
const textBlock = z.object({ type: z.literal("text"), text, textSignature: text.optional() });
const thinkingBlock = z.object({ type: z.literal("thinking"), thinking: text, thinkingSignature: text.optional(), redacted: z.boolean().optional() });
const toolCall = z.object({ type: z.literal("toolCall"), id: z.string().min(1).max(1024), name: z.string().min(1).max(128), arguments: z.record(z.string(), z.json()), thoughtSignature: text.optional(), namespace: z.string().max(128).optional() });
const assistant = z.object({ role: z.literal("assistant"), content: z.array(z.union([textBlock, thinkingBlock, toolCall])).max(128), api: z.string().max(128), provider: z.string().max(128), model: z.string().max(128), responseModel: z.string().max(128).optional(), responseId: z.string().max(1024).optional(), providerThinkingLevel: z.string().max(128).optional(), thinkingLevel: z.string().max(128).optional(), usage: z.object({ input: counter, output: counter, cacheRead: counter, cacheWrite: counter, totalTokens: counter, reasoning: counter.optional(), cost: z.object({ input: z.literal(0), output: z.literal(0), cacheRead: z.literal(0), cacheWrite: z.literal(0), total: z.literal(0) }) }), stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted"]), errorMessage: z.enum(["inference_bridge_aborted", "inference_bridge_provider_error", "inference_bridge_failed"]).optional(), timestamp: counter });
const indexed = { contentIndex: z.number().int().min(0).max(127), partial: assistant };
const eventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start"), partial: assistant }),
  ...["text_start", "thinking_start", "toolcall_start"].map(type => z.object({ type: z.literal(type), ...indexed })),
  ...["text_delta", "thinking_delta", "toolcall_delta"].map(type => z.object({ type: z.literal(type), ...indexed, delta: text })),
  ...["text_end", "thinking_end"].map(type => z.object({ type: z.literal(type), ...indexed, content: text })),
  z.object({ type: z.literal("toolcall_end"), ...indexed, toolCall }),
  z.object({ type: z.literal("done"), reason: z.enum(["stop", "length", "toolUse"]), message: assistant }),
  z.object({ type: z.literal("error"), reason: z.enum(["error", "aborted"]), error: assistant })
]);
const envelope = z.object({ version: z.literal(1), event: eventSchema }).strict();

function failedMessage(model: Model<Api>, aborted: boolean): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: aborted ? "aborted" : "error", errorMessage: aborted ? "inference_bridge_aborted" : "inference_bridge_failed", timestamp: Date.now() };
}

/** Server-owned subscription transport enabled by an explicit service binding. */
export function cloudAgentModel(env: Cloudflare.Env & BridgeEnvironment, config: AiModelConfig, initiator: AiChatAuthorInfo): ModelHandle | undefined {
  const bridge = env.CODEX_BRIDGE;
  if (!bridge) return undefined;
  let users: unknown;
  try { users = JSON.parse(env.CODEX_BRIDGE_ALLOWED_USER_IDS || ""); } catch { throw Error("inference_bridge_not_configured"); }
  const allowed = z.array(z.email().refine(value => value === value.toLowerCase())).min(1).max(20).safeParse(users);
  if (!allowed.success || !env.CODEX_BRIDGE_MODEL) throw Error("inference_bridge_not_configured");
  if (initiator.type !== "user" || !allowed.data.includes(initiator.id)) throw Error("inference_bridge_user_denied");
  if (config.provider !== "openai" || config.model !== env.CODEX_BRIDGE_MODEL || config.apiToken || config.apiUrl !== undefined || config.extraHeaders && Object.keys(config.extraHeaders).length) throw Error("inference_bridge_model_denied");
  const catalog = Object.values(OPENAI_CODEX_MODELS).find(model => model.id === env.CODEX_BRIDGE_MODEL);
  if (!catalog) throw Error("inference_bridge_model_unavailable");
  const model = { ...catalog, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  return {
    model,
    stream: (_model, context: Context, options: ModelStreamOptions = {}) => {
      const events = createAssistantMessageEventStream();
      const abort = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let terminal = false;
      let control: { cancel(): Promise<void>; [Symbol.dispose](): void } | undefined;
      let cancellation: Promise<void> | undefined;
      const stopReader = () => control || reader ? (cancellation ??= (async () => {
        await control?.cancel().catch(() => {});
        control?.[Symbol.dispose]();
        await reader?.cancel().catch(() => {});
      })()) : Promise.resolve();
      const finishError = () => {
        if (terminal) return;
        terminal = true;
        const reason = abort.signal.aborted ? "aborted" : "error";
        events.push({ type: "error", reason, error: failedMessage(model, reason === "aborted") });
      };
      const cancel = () => { abort.abort(); void stopReader().then(finishError); };
      options.signal?.addEventListener("abort", cancel, { once: true });
      const deadline = setTimeout(cancel, 125000);
      void (async () => {
        try {
          if (options.signal?.aborted) { cancel(); return; }
          const requested = options.thinking === false ? "minimal" : options.reasoning ?? config.reasoning ?? "low";
          const reasoning = requested === "off" ? "minimal" : requested;
          if (!["minimal", "low", "medium", "high", "xhigh"].includes(reasoning)) throw Error("inference_bridge_reasoning_denied");
          const input = { version: 1, requestId: crypto.randomUUID(), userId: initiator.id, context,
            options: { reasoning, maxTokens: Math.min(options.maxTokens ?? config.outputLimit ?? 4096, 8192) } };
          if (encoder.encode(JSON.stringify(input)).length > limit) throw Error("inference_bridge_input_too_large");
          const call = await bridge.infer(input);
          control = call.cancellation;
          reader = call.stream.getReader();
          if (abort.signal.aborted) { await stopReader(); finishError(); return; }
          let buffer = "", bytes = 0, started = false;
          const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
          while (!terminal) {
            const part = await reader.read();
            if (part.done) throw Error("inference_bridge_stream_incomplete");
            bytes += part.value.byteLength;
            if (bytes > outputLimit) throw Error("inference_bridge_output_too_large");
            buffer += decoder.decode(part.value, { stream: true });
            for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              if (encoder.encode(line).length > frameLimit) throw Error("inference_bridge_frame_too_large");
              // This protocol is the validated common subset of Pi 0.99.1 and 1.0.2 events.
              const event = envelope.parse(JSON.parse(line)).event as AssistantMessageEvent;
              if (event.type === "start") { if (started) throw Error("inference_bridge_event_order"); started = true; }
              else if (event.type !== "error" && !started) throw Error("inference_bridge_event_order");
              if (event.type === "done" || event.type === "error") { await stopReader(); terminal = true; }
              events.push(event);
              if (terminal) break;
            }
            if (encoder.encode(buffer).length > frameLimit) throw Error("inference_bridge_frame_too_large");
          }
        } catch { await stopReader(); finishError(); }
        finally { clearTimeout(deadline); options.signal?.removeEventListener("abort", cancel); await stopReader(); }
      })();
      return events;
    }
  };
}
