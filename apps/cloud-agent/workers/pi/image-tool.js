import { Type } from "typebox";
import { Check } from "typebox/value";

const encoder = new TextEncoder();
const MODEL = "gpt-image-2.5-flare", MAX_RESPONSE = 8 * 1024 * 1024, MAX_IMAGE = 5 * 1024 * 1024;
const MAX_EDGE = 4096, MAX_PIXELS = 16 * 1024 * 1024;
const parameters = Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 2000 }) }, { additionalProperties: false });
const validId = value => typeof value === "string" && /^[A-Za-z0-9_:-]{1,255}$/.test(value);
const validAsset = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
// ponytail: natural requests must be one bounded imperative, not quoted history;
// broader forms need a reviewed intent gate or the explicit /image command.
function explicitImage(value) {
  if (typeof value !== "string") return false;
  const request = value.trim();
  if (/^\/(?:image|이미지)\s+\S/i.test(request)) return true;
  if (request.length > 2000 || /[\r\n]/.test(request) || /(?:만들|그리|생성하)\s*지(?:는)?\s*(?:마|말|않)|(?:만들어|그려|생성해)\s*주지\s*(?:마|말)|\b(?:do not|don't|never)\b/i.test(request)) return false;
  if (/^[^\x22\x27\x60“”‘’:\r\n]{0,128}(?:이미지|그림|일러스트)(?:를|을)?\s*(?:(?:한\s*장(?:을)?|하나|좀)\s*)?(?:만들어|생성해|그려)\s*(?:줘|주세요)\s*[.!?]?$/.test(request)) return true;
  if (/^[^\x22\x27\x60“”‘’:\r\n]{1,128}\s*그려\s*(?:줘|주세요)\s*[.!?]?$/.test(request)) return true;
  return /^(?:for\s+[^\x22\x27\x60“”‘’:\r\n]{1,128},\s*)?(?:(?:please|can you|could you)\s+)?(?:(?:generate|create|make)\s+(?:an?\s+)?(?:image|picture|illustration)\b|draw\s+\S)/i.test(request);
}
const insist = (ok, code) => { if (!ok) throw Error(code); };
const hash = async value => [...new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)))].map(byte => byte.toString(16).padStart(2, "0")).join("");
const keyFor = async (tenant, asset) => `images/${await hash(tenant)}/${asset}`;
const mediaTypeValid = value => value === "image/png" || value === "image/webp";
const dimensionsValid = (width, height) => Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= MAX_EDGE && height <= MAX_EDGE && width * height <= MAX_PIXELS;
const failureCode = error => ["image_input_invalid", "image_disabled", "image_not_configured", "image_auth_needed", "image_permission_denied", "image_upstream_blocked", "image_caller_denied", "image_explicit_request_required", "image_source_already_used", "image_response_invalid", "image_response_too_large"].includes(error?.message) || /^codex_image_http_[1-5]\d{2}$/.test(error?.message) ? error.message : "image_generation_unknown";
function imageDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const { phase, status, category, contentType, requestId, rayId, challenge } = value;
  const id = value => value === null || typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
  if (phase !== "image" || !(status === null || Number.isInteger(status) && status >= 100 && status <= 599) || !["success", "auth_required", "permission_denied", "rate_limited", "upstream_blocked", "upstream_error", "invalid_response"].includes(category) || !["json", "html", "sse", "other", "missing"].includes(contentType) || !id(requestId) || !id(rayId) || typeof challenge !== "boolean") return;
  return { phase, status, category, contentType, requestId, rayId, challenge };
}
function failure(status, code, diagnostic) {
  const safe = imageDiagnostic(diagnostic);
  return { status, code, ...(safe ? { diagnostic: safe } : {}) };
}

function origin(env) {
  let value;
  try { value = new URL(env.PUBLIC_ORIGIN); } catch { throw Error("image_not_configured"); }
  insist(value.protocol === "https:" && !value.username && !value.password && !value.search && !value.hash && value.pathname === "/", "image_not_configured");
  return value.origin;
}
function result(row, base) {
  return row.status === "ready" ? { status: "ready", assetId: row.assetId, url: `${base}/assets/${row.assetId}`, mediaType: row.mediaType, bytes: row.bytes, width: row.width, height: row.height } : failure(row.status === "dispatching" ? "unknown" : row.status, row.code ?? "image_generation_unknown", row.diagnostic);
}
async function jsonBounded(response) {
  const reader = response.body?.getReader(); insist(reader, "image_response_invalid");
  const parts = []; let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_RESPONSE) { await reader.cancel(); throw Error("image_response_too_large"); }
      parts.push(chunk.value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error?.message === "image_response_too_large") throw error;
    throw Error("image_response_invalid");
  } finally { reader.releaseLock(); }
}

function imageBytes(value) {
  insist(typeof value === "string" && value.length <= 4 * Math.ceil(MAX_IMAGE / 3) && value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value), "image_response_invalid");
  let binary; try { binary = atob(value); } catch { throw Error("image_response_invalid"); }
  insist(binary.length >= 30 && binary.length <= MAX_IMAGE, "image_response_invalid");
  return imageContent(Uint8Array.from(binary, char => char.charCodeAt(0)));
}

function imageContent(bytes) {
  insist(bytes.byteLength >= 30 && bytes.byteLength <= MAX_IMAGE, "image_response_invalid");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const four = offset => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  // ponytail: validate format headers and chunk bounds, not full pixel decoding;
  // decoding belongs in a native image service if formats or transforms expand.
  if (bytes.subarray(0, 8).every((byte, index) => byte === [137,80,78,71,13,10,26,10][index])) {
    insist(bytes.length >= 45 && view.getUint32(8) === 13 && four(12) === "IHDR", "image_response_invalid");
    const width = view.getUint32(16), height = view.getUint32(20);
    insist(dimensionsValid(width, height), "image_response_invalid");
    insist([1,2,4,8,16].includes(bytes[24]) && [0,2,3,4,6].includes(bytes[25]) && bytes[26] === 0 && bytes[27] === 0 && bytes[28] <= 1, "image_response_invalid");
    let data = false, ended = false;
    for (let at = 8; at < bytes.length;) {
      insist(at + 12 <= bytes.length, "image_response_invalid");
      const size = view.getUint32(at), kind = four(at + 4), end = at + 12 + size;
      insist(end <= bytes.length && !["acTL", "fcTL", "fdAT"].includes(kind) && (at === 8 || kind !== "IHDR"), "image_response_invalid");
      if (kind === "IDAT") data = true;
      if (kind === "IEND") { insist(size === 0 && end === bytes.length && data, "image_response_invalid"); ended = true; }
      at = end;
    }
    insist(ended, "image_response_invalid"); return { bytes, mediaType: "image/png", width, height };
  }
  insist(four(0) === "RIFF" && four(8) === "WEBP" && view.getUint32(4, true) + 8 === bytes.length, "image_response_invalid");
  let frame, canvas;
  for (let at = 12; at < bytes.length;) {
    insist(at + 8 <= bytes.length, "image_response_invalid");
    const kind = four(at), size = view.getUint32(at + 4, true), start = at + 8, end = start + size;
    insist(end + (size & 1) <= bytes.length && !["ANIM", "ANMF"].includes(kind), "image_response_invalid");
    if (kind === "VP8X") {
      insist(size === 10 && !canvas && !(bytes[start] & 2), "image_response_invalid");
      const width = 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16);
      const height = 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16);
      insist(dimensionsValid(width, height), "image_response_invalid"); canvas = { width, height };
    }
    if (kind === "VP8 " || kind === "VP8L") {
      insist(!frame, "image_response_invalid"); let width, height;
      if (kind === "VP8 ") {
        insist(size >= 10 && !(bytes[start] & 1) && bytes[start + 3] === 157 && bytes[start + 4] === 1 && bytes[start + 5] === 42, "image_response_invalid");
        width = view.getUint16(start + 6, true) & 16383; height = view.getUint16(start + 8, true) & 16383;
      } else {
        insist(size >= 5 && bytes[start] === 47, "image_response_invalid");
        const bits = view.getUint32(start + 1, true); width = 1 + (bits & 16383); height = 1 + ((bits >>> 14) & 16383);
      }
      insist(dimensionsValid(width, height), "image_response_invalid"); frame = { width, height };
    }
    at = end + (size & 1);
  }
  insist(frame && (!canvas || canvas.width === frame.width && canvas.height === frame.height), "image_response_invalid");
  return { bytes, mediaType: "image/webp", ...frame };
}

// The default transport is explicitly paid API usage. A separately reviewed,
// server-owned transport may be injected; no endpoint/provider enters tool args.
async function generateViaApi({ env, prompt, signal }) {
  return fetch("https://api.openai.com/v1/images/generations", {
    method: "POST", redirect: "manual", signal,
    headers: { "content-type": "application/json", authorization: "Bearer " + env.IMAGE_OPENAI_API_KEY },
    body: JSON.stringify({ model: MODEL, prompt, n: 1, size: "1024x1024", quality: "low", output_format: "webp", output_compression: 80, background: "opaque" }),
  });
}

export function installImageTool({ registry, env, resolveCaller, ledger, generate }) {
  const readResult = async (row, jobKey, base) => {
    if (row.status === "dispatching" || row.status === "unknown" || row.status === "ready" && !dimensionsValid(row.width, row.height)) {
      insist(env.IMAGE_ASSETS, "image_disabled");
      const stored = await env.IMAGE_ASSETS.get(await keyFor(row.tenantId, row.assetId));
      if (stored && stored.customMetadata?.tenantId === row.tenantId && stored.customMetadata?.assetId === row.assetId && mediaTypeValid(stored.httpMetadata?.contentType) && stored.size >= 30 && stored.size <= MAX_IMAGE) {
        const image = imageContent(new Uint8Array(await stored.arrayBuffer()));
        insist(image.bytes.byteLength === stored.size && image.mediaType === stored.httpMetadata.contentType, "image_response_invalid");
        row = { ...row, status: "ready", bytes: stored.size, mediaType: image.mediaType, width: image.width, height: image.height }; await ledger.put(jobKey, row);
      }
    }
    insist(row.status !== "ready" || dimensionsValid(row.width, row.height), "image_response_invalid");
    return result(row, base);
  };
  const executeImage = async (args, caller, context = {}) => {
    let jobKey, row, base;
    try {
      insist(Check(parameters, args) && args.prompt.trim().length > 0 && !args.prompt.includes("\0") && encoder.encode(args.prompt).length <= 8192, "image_input_invalid");
      insist(env.IMAGE_ENABLED === "true" && env.IMAGE_ASSETS && ledger?.transaction, "image_disabled");
      insist(["api", "codex"].includes(env.IMAGE_PROVIDER), "image_not_configured");
      const codex = env.IMAGE_PROVIDER === "codex", transport = codex ? generate : generateViaApi;
      if (codex) insist(typeof transport === "function", "image_auth_needed");
      else insist(env.IMAGE_PAID_APPROVED === "true" && typeof env.IMAGE_OPENAI_API_KEY === "string" && env.IMAGE_OPENAI_API_KEY.length >= 16, "image_not_configured");
      insist(!env.IMAGE_MODEL || env.IMAGE_MODEL === (codex ? "gpt-image-2" : MODEL), "image_not_configured"); base = origin(env);
      insist(caller && validId(caller.tenantId) && caller.tenantId === env.TENANT_ID && validId(caller.sourceOperationId), "image_caller_denied");
      insist(explicitImage(caller.explicitRequest), "image_explicit_request_required");
      const prompt = args.prompt.trim(), promptDigest = await hash(prompt);
      jobKey = `image-job:${await hash(JSON.stringify([caller.tenantId, caller.sourceOperationId]))}`;
      const claim = await ledger.transaction(async transaction => {
        const previous = await transaction.get(jobKey);
        if (previous) return { created: false, row: previous };
        const row = { status: "dispatching", assetId: crypto.randomUUID(), promptDigest, tenantId: caller.tenantId };
        await transaction.put(jobKey, row); return { created: true, row };
      });
      row = claim.row;
      insist(row.promptDigest === promptDigest && row.tenantId === caller.tenantId, "image_source_already_used");
      const objectKey = await keyFor(row.tenantId, row.assetId);
      if (!claim.created) return await readResult(row, jobKey, base);
      let response;
      try {
        const signal = AbortSignal.any([AbortSignal.timeout(90000), ...(context?.abortSignal ? [context.abortSignal] : [])]);
        signal.throwIfAborted();
        response = await transport({ env, prompt, signal });
      }
      catch (error) {
        const code = codex ? failureCode(error) : "image_generation_unknown", diagnostic = codex ? imageDiagnostic(error?.diagnostic) : undefined;
        const unknown = code === "image_generation_unknown" || diagnostic?.status >= 500 || diagnostic?.status === 408;
        row = { ...row, status: unknown ? "unknown" : "failed", code, ...(diagnostic ? { diagnostic } : {}) }; await ledger.put(jobKey, row); return result(row, base);
      }
      if (response.status >= 500 || response.status === 408) { row = { ...row, status: "unknown", code: "image_generation_unknown" }; await ledger.put(jobKey, row); return result(row, base); }
      if (!response.ok) { row = { ...row, status: "failed", code: codex && response.status === 401 ? "image_auth_needed" : codex && response.status === 403 ? "image_permission_denied" : "image_provider_rejected" }; await ledger.put(jobKey, row); return result(row, base); }
      const data = await jsonBounded(response);
      insist(Array.isArray(data?.data) && data.data.length === 1, "image_response_invalid");
      const { bytes, mediaType, width, height } = imageBytes(data.data[0]?.b64_json);
      try { await env.IMAGE_ASSETS.put(objectKey, bytes, { httpMetadata: { contentType: mediaType }, customMetadata: { tenantId: row.tenantId, assetId: row.assetId, width: String(width), height: String(height) } }); }
      catch { row = { ...row, status: "unknown", code: "image_storage_unknown" }; await ledger.put(jobKey, row); return result(row, base); }
      row = { ...row, status: "ready", bytes: bytes.byteLength, mediaType, width, height }; await ledger.put(jobKey, row); return result(row, base);
    } catch (error) {
      const code = failureCode(error);
      if (row && jobKey && !["image_source_already_used"].includes(code)) {
        try { await ledger.put(jobKey, { ...row, status: code === "image_generation_unknown" ? "unknown" : "failed", code }); } catch {}
      }
      return failure(code === "image_generation_unknown" ? "unknown" : "failed", code);
    }
  };
  registry.install({ name: "image-generation", tools: [{ name: "generate_image", description: "Available only within a signed Channel App command or admitted staff message in the configured test room. Generate one private image from the current user's explicit image request. One image per source request; interrupted generation is never repeated automatically.", parameters, replay: "unsafe", executionMode: "sequential", execute: async (args, api, context) => {
    let result;
    try { result = await executeImage(args, await resolveCaller(api, context), context); }
    catch { result = failure("failed", "image_caller_denied"); }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } }] });
  executeImage.resultFor = async caller => {
    try {
      insist(caller && validId(caller.tenantId) && caller.tenantId === env.TENANT_ID && validId(caller.sourceOperationId), "image_caller_denied");
      insist(ledger?.get, "image_disabled");
      const jobKey = `image-job:${await hash(JSON.stringify([caller.tenantId, caller.sourceOperationId]))}`, row = await ledger.get(jobKey);
      if (!row) return null;
      insist(row.tenantId === caller.tenantId && validAsset(row.assetId), "image_caller_denied");
      return await readResult(row, jobKey, origin(env));
    } catch (error) {
      const code = failureCode(error);
      return failure(code === "image_generation_unknown" ? "unknown" : "failed", code);
    }
  };
  return executeImage;
}

// session is supplied only after the caller's existing SSO authorization gate.
export async function serveImageAsset(request, env, session) {
  const headers = { "cache-control": "private, no-store", "x-content-type-options": "nosniff" };
  if (!session || !validId(session.tenantId) || session.tenantId !== env.TENANT_ID) return new Response(null, { status: 403, headers });
  if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, allow: "GET, HEAD" } });
  const assetId = new URL(request.url).pathname.match(/^\/assets\/([^/]+)$/)?.[1];
  if (!validAsset(assetId) || !env.IMAGE_ASSETS) return new Response(null, { status: 404, headers });
  try {
    const image = await env.IMAGE_ASSETS.get(await keyFor(session.tenantId, assetId));
    if (!image || image.customMetadata?.tenantId !== session.tenantId || image.customMetadata?.assetId !== assetId || !mediaTypeValid(image.httpMetadata?.contentType) || image.size < 30 || image.size > MAX_IMAGE) return new Response(null, { status: 404, headers });
    return new Response(request.method === "HEAD" ? null : image.body, { headers: { ...headers, "content-type": image.httpMetadata.contentType, "content-length": String(image.size) } });
  } catch { return new Response(null, { status: 503, headers }); }
}
