import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { z } from "zod";
import { installSubscriptionModels } from "./subscription-models.js";
import { codexPayloadShape, codexRequestShape } from "./codex-http.js";

const encoder = new TextEncoder();
const INPUT_LIMIT = 1048576, FRAME_LIMIT = 524288, OUTPUT_LIMIT = 8388608;
const DIAGNOSTIC_WIRE_LIMIT = 16777216; // Observation bound only; this does not limit provider transport.
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
  const requestEncoding = env.INFERENCE_BRIDGE_REQUEST_ENCODING ?? "native";
  if (!["native", "identity"].includes(requestEncoding)) fail("inference_bridge_not_configured");
  return { users, accountId: env.INFERENCE_BRIDGE_ACCOUNT_ID, modelId: env.INFERENCE_BRIDGE_MODEL, timeoutMs, requestEncoding };
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

// Explicit projection: provider diagnostics can contain identifiers and must never be logged wholesale.
function credentialExpiry(token, now = Date.now()) {
  try {
    if (typeof token !== "string" || token.length > 32768) return "unavailable";
    const parts = token.split(".");
    if (parts.length !== 3) return "unavailable";
    const claims = JSON.parse(atob(parts[1].replaceAll("-", "+").replaceAll("_", "/")));
    const expiry = claims?.exp;
    return typeof expiry === "number" && Number.isFinite(expiry * 1000) ? expiry * 1000 > now ? "future" : "expired" : "unavailable";
  } catch { return "unavailable"; }
}

function htmlDiagnostic(markers) {
  const marker = value => Array.isArray(markers) ? markers.includes(value) : null;
  return {
    htmlAttentionRequired: marker("cf_attention_required"), htmlJustAMoment: marker("cf_just_a_moment"),
    htmlErrorDetails: marker("cf_error_details"), htmlErrorCode: marker("cf_error_code"),
    htmlCode1020: marker("cf_code_1020"), htmlCode1009: marker("cf_code_1009"), htmlCode1015: marker("cf_code_1015"),
    htmlBlockedPhrase: marker("cf_blocked_phrase")
  };
}

function terminalDiagnostic({ credentialAccessFailed, fetchAttempted, responseReceived, response, request, payload, credentialExpiry, responseMetadata }) {
  const boolean = value => typeof value === "boolean" ? value : null;
  const category = ["upstream_blocked", "permission_denied", "invalid_response", "success", "auth_required", "rate_limited", "upstream_error"].includes(response?.category) ? response.category : null;
  const contentType = ["json", "html", "sse", "other", "missing"].includes(response?.contentType) ? response.contentType : null;
  return {
    phase: credentialAccessFailed ? "credential" : !fetchAttempted ? "provider_setup" : responseReceived ? "response" : "fetch",
    credentialAccessFailed, fetchAttempted, responseReceived,
    credentialExpiry: ["future", "expired", "unavailable"].includes(credentialExpiry) ? credentialExpiry : null,
    responseEdgeColo: typeof responseMetadata?.edgeColo === "string" && /^[A-Z]{3}$/.test(responseMetadata.edgeColo) ? responseMetadata.edgeColo : null,
    responseServer: ["cloudflare", "nginx", "envoy", "other", "missing"].includes(responseMetadata?.server) ? responseMetadata.server : null,
    status: Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599 ? response.status : null,
    category, contentType, challenge: boolean(response?.challenge),
    responseRedirected: boolean(response?.redirected), responseFinalEndpointExpected: boolean(response?.expectedFinalEndpoint),
    cfErrorType: ["1000", "1016", "1101", "1102", "521", "522", "523", "524", "525", "526", "1020", "1009", "1015", "other"].includes(response?.cfErrorType) ? response.cfErrorType : null,
    cfErrorOriginPresent: boolean(response?.cfErrorOriginPresent),
    htmlAttentionRequired: boolean(response?.htmlAttentionRequired), htmlJustAMoment: boolean(response?.htmlJustAMoment),
    htmlErrorDetails: boolean(response?.htmlErrorDetails), htmlErrorCode: boolean(response?.htmlErrorCode),
    htmlCode1020: boolean(response?.htmlCode1020), htmlCode1009: boolean(response?.htmlCode1009), htmlCode1015: boolean(response?.htmlCode1015),
    htmlBlockedPhrase: boolean(response?.htmlBlockedPhrase), htmlTruncated: boolean(response?.htmlTruncated),
    requestEndpointExpected: boolean(request?.expectedEndpoint),
    requestAuthorizationPresent: boolean(request?.headers?.authorization),
    requestAccountPresent: boolean(request?.headers?.account),
    requestContentTypePresent: boolean(request?.headers?.contentType),
    requestAcceptPresent: boolean(request?.headers?.accept),
    requestWireEncoding: ["identity", "zstd", "other"].includes(request?.wire?.encoding) ? request.wire.encoding : null,
    requestWireKind: ["string", "bytes", "stream", "other"].includes(request?.wire?.kind) ? request.wire.kind : null,
    requestWireByteLength: Number.isSafeInteger(request?.wire?.byteLength) && request.wire.byteLength >= 0 && request.wire.byteLength <= DIAGNOSTIC_WIRE_LIMIT ? request.wire.byteLength : null,
    payloadStoreFalse: boolean(payload?.storeFalse), payloadStreamTrue: boolean(payload?.streamTrue),
    payloadInputArray: boolean(payload?.inputArray), payloadToolSchemaValid: boolean(payload?.toolSchemaValid)
  };
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
    const observed = { credentialAccessFailed: false, fetchAttempted: false, responseReceived: false };
    const credentialFacade = { async codexAccess() {
      try {
        const credential = await credentials.codexAccess();
        observed.credentialExpiry = credentialExpiry(credential?.access);
        return credential;
      }
      catch (error) { observed.credentialAccessFailed = true; throw error; }
    } };
    installSubscriptionModels(models, () => credentialFacade, undefined, diagnostic => {
      // Retain only observations used by the fixed terminal schema, never a raw error or response body.
      if (observed.responseReceived) observed.response = {
        status: diagnostic.status, category: diagnostic.category, contentType: diagnostic.contentType, challenge: diagnostic.challenge,
        redirected: diagnostic.responseShape?.redirected, expectedFinalEndpoint: diagnostic.responseShape?.expectedFinalEndpoint,
        cfErrorType: diagnostic.cfErrorType, cfErrorOriginPresent: diagnostic.cfErrorOriginPresent,
        ...htmlDiagnostic(diagnostic.htmlMarkers), htmlTruncated: diagnostic.htmlTruncated
      };
    });
    const model = models.getModel("openai-codex", configured.modelId);
    if (!model) fail("inference_bridge_model_unavailable");
    // Credentials status is local; an in-flight credential refresh retains its existing HTTP timeout.
    const abort = new AbortController(), deadline = setTimeout(() => abort.abort(), configured.timeoutMs);
    let identityBody;
    const iterator = models.streamSimple(model, input.context, {
      ...input.options, maxTokens: input.options.maxTokens ?? 4096, signal: abort.signal,
      fetch: async (...args) => {
        observed.fetchAttempted = true;
        observed.responseReceived = false;
        observed.response = undefined;
        observed.responseMetadata = undefined;
        observed.request = undefined;
        if (configured.requestEncoding === "identity") {
          if (typeof identityBody !== "string") fail("inference_bridge_payload_unavailable");
          const headers = new Headers(args[1]?.headers);
          headers.delete("content-encoding");
          args = [args[0], { ...args[1], headers, body: identityBody }];
        }
        try { observed.request = codexRequestShape(args[0], args[1], model.id); } catch { /* Observation cannot change transport. */ }
        const response = await globalThis.fetch(...args);
        observed.responseReceived = true;
        try {
          const edgeColo = response.headers.get("cf-ray")?.match(/-([A-Z]{3})$/)?.[1] ?? null;
          const server = response.headers.get("server")?.trim().toLowerCase();
          observed.responseMetadata = { edgeColo, server: server == null ? "missing" : ["cloudflare", "nginx", "envoy"].includes(server) ? server : "other" };
        } catch { /* Observation cannot change provider behavior. */ }
        return response;
      },
      onPayload: body => {
        // Keep the exact provider JSON only for this call; native encoding forwards the original fetch arguments.
        if (configured.requestEncoding === "identity") identityBody = JSON.stringify(body);
        try { observed.payload = codexPayloadShape(body); } catch { /* Observation cannot change payload. */ }
      }
    })[Symbol.asyncIterator]();
    let terminal = false, started = false, total = 0;
    let diagnosticLogged = false;
    const logProviderFailure = () => {
      if (diagnosticLogged) return;
      diagnosticLogged = true;
      try { console.warn("inference_bridge_diagnostic", JSON.stringify(terminalDiagnostic(observed))); }
      catch { /* Logging cannot alter wire errors, stream lifetime or cancellation. */ }
    };
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
          if (event.type === "error" && event.reason !== "aborted" && !abort.signal.aborted) logProviderFailure();
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
