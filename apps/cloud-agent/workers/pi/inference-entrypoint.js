import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { z } from "zod";
import { installSubscriptionModels } from "./subscription-models.js";

const encoder = new TextEncoder();
const INPUT_LIMIT = 1048576, FRAME_LIMIT = 524288, OUTPUT_LIMIT = 8388608;
const fail = code => { throw Error(code); };
const text = z.string().max(262144);
const jsonObject = z.record(z.string(), z.json());
const textBlock = z.object({ type: z.literal("text"), text, textSignature: text.optional() });
const thinkingBlock = z.object({ type: z.literal("thinking"), thinking: text, thinkingSignature: text.optional(), redacted: z.boolean().optional() });
const toolCall = z.object({ type: z.literal("toolCall"), id: z.string().min(1).max(1024), name: z.string().min(1).max(128), arguments: jsonObject, thoughtSignature: text.optional(), namespace: z.string().max(128).optional() });
const tool = z.object({ name: z.string().min(1).max(128), description: text, parameters: jsonObject });
const counter = z.number().int().nonnegative();
const usage = z.object({ input: counter, output: counter, cacheRead: counter, cacheWrite: counter, totalTokens: counter, reasoning: counter.optional(), cost: z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number(), total: z.number() }) });
const assistant = z.object({ role: z.literal("assistant"), content: z.array(z.union([textBlock, thinkingBlock, toolCall])).max(128), api: z.string().max(128), provider: z.string().max(128), model: z.string().max(128), responseModel: z.string().max(128).optional(), responseId: z.string().max(1024).optional(), providerThinkingLevel: z.string().max(128).optional(), thinkingLevel: z.string().max(128).optional(), usage, stopReason: z.enum(["pending", "stop", "length", "toolUse", "error", "aborted"]), timestamp: counter });
const message = z.discriminatedUnion("role", [
  z.object({ role: z.literal("system"), content: z.union([text, z.array(textBlock).max(128)]), timestamp: counter, sections: z.record(z.string().max(128), text.nullable()).optional(), toolsAdded: z.array(tool).max(64).optional(), toolsRemoved: z.array(z.object({ name: z.string().max(128) })).max(64).optional() }),
  z.object({ role: z.literal("user"), content: z.union([text, z.array(textBlock).max(128)]), timestamp: counter }),
  assistant,
  z.object({ role: z.literal("toolResult"), toolCallId: z.string().min(1).max(1024), toolName: z.string().min(1).max(128), content: z.array(textBlock).max(128), isError: z.boolean(), timestamp: counter })
]);
const requestSchema = z.object({
  version: z.literal(1), requestId: z.uuid(), userId: z.email().max(254),
  context: z.object({ systemPrompt: text.optional(), messages: z.array(message).min(1).max(256), tools: z.array(tool).max(64).optional() }).strict(),
  options: z.object({ reasoning: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(), maxTokens: z.number().int().min(1).max(8192).optional() }).strict()
}).strict();

function policy(env) {
  let users;
  try { users = JSON.parse(env.INFERENCE_BRIDGE_ALLOWED_USER_IDS); } catch { fail("inference_bridge_not_configured"); }
  if (!Array.isArray(users) || !users.length || users.length > 20 || users.some(user => !z.email().safeParse(user).success || user !== user.toLowerCase())) fail("inference_bridge_not_configured");
  if (!/^(owner|account-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(env.INFERENCE_BRIDGE_ACCOUNT_ID || "") || !/^[a-zA-Z0-9._-]{1,128}$/.test(env.INFERENCE_BRIDGE_MODEL || "")) fail("inference_bridge_not_configured");
  const timeoutMs = Number(env.INFERENCE_BRIDGE_TIMEOUT_MS ?? 120000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) fail("inference_bridge_not_configured");
  return { users, accountId: env.INFERENCE_BRIDGE_ACCOUNT_ID, modelId: env.INFERENCE_BRIDGE_MODEL, timeoutMs };
}

function safeMessage(value) {
  const parsed = assistant.safeParse(value);
  if (!parsed.success) fail("inference_bridge_response_invalid");
  return { ...parsed.data, usage: { ...parsed.data.usage, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

function safeEvent(event) {
  if (event.type === "error") return { type: "error", reason: event.reason === "aborted" ? "aborted" : "error", error: { ...safeMessage(event.error), errorMessage: event.reason === "aborted" ? "inference_bridge_aborted" : "inference_bridge_provider_error" } };
  if (event.type === "done") return { type: "done", reason: event.reason, message: safeMessage(event.message) };
  const partial = safeMessage(event.partial);
  if (event.type === "start") return { type: "start", partial };
  if (!Number.isInteger(event.contentIndex) || event.contentIndex < 0 || event.contentIndex > 127) fail("inference_bridge_response_invalid");
  const base = { type: event.type, contentIndex: event.contentIndex, partial };
  if (["text_start", "thinking_start", "toolcall_start"].includes(event.type)) return base;
  if (["text_delta", "thinking_delta", "toolcall_delta"].includes(event.type) && typeof event.delta === "string") return { ...base, delta: event.delta };
  if (["text_end", "thinking_end"].includes(event.type) && typeof event.content === "string") return { ...base, content: event.content };
  if (event.type === "toolcall_end") return { ...base, toolCall: toolCall.parse(event.toolCall) };
  fail("inference_bridge_response_invalid");
}

function errorMessage(model, aborted) {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: aborted ? "aborted" : "error", errorMessage: aborted ? "inference_bridge_aborted" : "inference_bridge_failed", timestamp: Date.now() };
}

class InferenceCancellation extends RpcTarget {
  #cancel;
  constructor(cancel) { super(); this.#cancel = cancel; }
  cancel() { this.#cancel(); }
}

/** Inference capability for a trusted Worker binding; deliberately has no HTTP handler. */
export class CloudAgentInference extends WorkerEntrypoint {
  async infer(value) {
    const configured = policy(this.env);
    let size;
    try { size = encoder.encode(JSON.stringify(value)).length; } catch { fail("inference_bridge_input_invalid"); }
    if (size > INPUT_LIMIT) fail("inference_bridge_input_too_large");
    const parsed = requestSchema.safeParse(value);
    if (!parsed.success) fail("inference_bridge_input_invalid");
    const input = parsed.data;
    if (!configured.users.includes(input.userId)) fail("inference_bridge_user_denied");
    const credentials = this.env.Credentials.getByName(configured.accountId);
    const status = await credentials.status();
    if (!status.inferenceReady || status.provider !== "codex") fail("inference_bridge_account_unavailable");
    const models = createModels();
    installSubscriptionModels(models, () => credentials);
    const model = models.getModel("openai-codex", configured.modelId);
    if (!model) fail("inference_bridge_model_unavailable");
    // Credentials status is local; an in-flight credential refresh retains its existing HTTP timeout.
    const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), configured.timeoutMs);
    const iterator = models.streamSimple(model, input.context, { ...input.options, maxTokens: input.options.maxTokens ?? 4096, signal: abort.signal })[Symbol.asyncIterator]();
    let terminal = false, started = false, total = 0;
    const close = () => { clearTimeout(deadline); abort.abort(); };
    const stream = new ReadableStream({
      type: "bytes",
      async pull(controller) {
        if (terminal) { controller.close(); return; }
        try {
          const next = await iterator.next();
          if (next.done) fail("inference_bridge_stream_incomplete");
          const event = safeEvent(next.value);
          if (event.type === "start") { if (started) fail("inference_bridge_response_invalid"); started = true; }
          else if (event.type !== "error" && !started) fail("inference_bridge_response_invalid");
          // ponytail: full partial snapshots cap this pilot at 8 MiB; use delta-only framing for longer turns.
          const bytes = encoder.encode(JSON.stringify({ version: 1, event }) + "\n");
          total += bytes.byteLength;
          if (bytes.byteLength > FRAME_LIMIT || total > OUTPUT_LIMIT) fail("inference_bridge_output_too_large");
          terminal = event.type === "done" || event.type === "error";
          controller.enqueue(bytes);
          if (terminal) { close(); controller.close(); }
        } catch {
          terminal = true;
          const reason = abort.signal.aborted ? "aborted" : "error";
          close();
          controller.enqueue(encoder.encode(JSON.stringify({ version: 1, event: { type: "error", reason, error: errorMessage(model, reason === "aborted") } }) + "\n"));
          controller.close();
        }
      },
      async cancel() { terminal = true; close(); await iterator.return?.(); }
    });
    return { stream, cancellation: new InferenceCancellation(close) };
  }
}
