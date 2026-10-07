const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const endpoint = value => {
  try { return new URL(value).href === "https://chatgpt.com/backend-api/codex/responses"; } catch { return null; }
};

// Inspect data properties only: diagnostics must not run payload accessors or toJSON.
const unobserved = Symbol("unobserved");
const data = (value, key) => { const field = Object.getOwnPropertyDescriptor(value, key); return field ? Object.hasOwn(field, "value") ? field.value : unobserved : undefined; };
export function codexPayloadShape(body) {
  const unavailable = { storeFalse: null, streamTrue: null, inputArray: null, toolSchemaValid: null };
  try {
    if (!object(body) || ![Object.prototype, null].includes(Object.getPrototypeOf(body)) || data(body, "toJSON") !== undefined) return unavailable;
    const store = object(body) ? data(body, "store") : undefined, stream = object(body) ? data(body, "stream") : undefined, input = object(body) ? data(body, "input") : undefined;
    let tools = null;
    if (object(body)) {
      const declared = data(body, "tools");
      if (declared === undefined) tools = true;
      else if (Array.isArray(declared)) {
        const valid = Array.from({ length: data(declared, "length") }, (_, index) => {
          const tool = data(declared, String(index));
          if (tool === unobserved) return null;
          if (!object(tool)) return false;
          const name = data(tool, "name"), type = data(tool, "type");
          if (name === unobserved || type === unobserved) return null;
          if (typeof name !== "string" || !name) return false;
          if (type === "function") { const parameters = data(tool, "parameters"); return parameters === unobserved ? null : object(parameters); }
          if (type !== "custom") return null;
          const format = data(tool, "format");
          if (format === unobserved) return null;
          if (!object(format)) return false;
          const kind = data(format, "type"), syntax = data(format, "syntax"), definition = data(format, "definition");
          return [kind, syntax, definition].includes(unobserved) ? null : kind === "grammar" && ["lark", "regex"].includes(syntax) && typeof definition === "string";
        });
        tools = valid.includes(false) ? false : valid.includes(null) ? null : true;
      } else if (declared !== unobserved) tools = false;
    }
    return { storeFalse: store === unobserved ? null : store === false, streamTrue: stream === unobserved ? null : stream === true, inputArray: input === unobserved ? null : Array.isArray(input), toolSchemaValid: tools };
  } catch { return unavailable; }
}

export function codexRequestShape(input, init, modelId) {
  const shape = { attemptId: crypto.randomUUID(), modelId: typeof modelId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(modelId) ? modelId : null, expectedEndpoint: endpoint(typeof input === "string" || input instanceof URL ? input : input?.url), method: null, headers: { authorization: null, account: null, contentType: null, accept: null }, body: { parsedJson: null, storeFalse: null, streamTrue: null, inputArray: null, toolSchemaValid: null }, wire: { encoding: null, kind: null, byteLength: null } };
  try {
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    shape.method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"].includes(method) ? method : "other";
    const headers = new Headers(init?.headers ?? input?.headers);
    shape.headers = { authorization: headers.has("authorization"), account: headers.has("chatgpt-account-id"), contentType: headers.has("content-type"), accept: headers.has("accept") };
    const encoding = headers.get("content-encoding")?.trim().toLowerCase();
    shape.wire.encoding = encoding === undefined || encoding === "identity" ? "identity" : encoding === "zstd" ? "zstd" : "other";
  } catch { }
  try {
    const body = init == null ? undefined : data(init, "body");
    shape.wire.kind = typeof body === "string" ? "string" : body instanceof ArrayBuffer || ArrayBuffer.isView(body) ? "bytes" : body instanceof ReadableStream ? "stream" : body == null || body === unobserved ? null : "other";
    shape.wire.byteLength = typeof body === "string" ? new TextEncoder().encode(body).byteLength : body instanceof ArrayBuffer ? Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength").get.call(body) : ArrayBuffer.isView(body) ? Object.getOwnPropertyDescriptor(body instanceof DataView ? DataView.prototype : Object.getPrototypeOf(Uint8Array.prototype), "byteLength").get.call(body) : null;
  } catch { }
  if (typeof init?.body === "string") {
    try {
      const body = JSON.parse(init.body);
      shape.body = { parsedJson: true, ...(object(body) ? codexPayloadShape(body) : { storeFalse: false, streamTrue: false, inputArray: false, toolSchemaValid: null }) };
    } catch { shape.body.parsedJson = false; }
  }
  return shape;
}

export function codexResponseShape(response) {
  return { redirected: typeof response?.redirected === "boolean" ? response.redirected : null, expectedFinalEndpoint: response?.url ? endpoint(response.url) : null };
}

export function codexDiagnostic(phase, { status, headers }) {
  const values = new Headers(headers);
  const type = values.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const contentType = type === "application/json" || type?.endsWith("+json") ? "json" : type === "text/html" || type === "application/xhtml+xml" ? "html" : type === "text/event-stream" ? "sse" : type ? "other" : "missing";
  const challenge = values.get("cf-mitigated")?.toLowerCase() === "challenge";
  const errorType = values.get("cf-error-type");
  status = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
  const category = challenge ? "upstream_blocked" : status === 403 ? "permission_denied" : status >= 200 && status < 300 ? contentType === "html" ? "invalid_response" : "success" : contentType === "json" && status === 401 ? "auth_required" : status === 429 ? "rate_limited" : "upstream_error";
  return {
    phase, status,
    category, cause: challenge ? "challenge" : category === "success" ? null : "unknown",
    contentType, errorBodyFormat: null,
    requestId: id(values.get("x-codex-imagegen-request-id")) ?? id(values.get("x-request-id")),
    rayId: id(values.get("cf-ray")), challenge,
    cfErrorType: errorType === null ? null : ["1000", "1016", "1101", "1102", "521", "522", "523", "524", "525", "526", "1020", "1009", "1015"].includes(errorType) ? errorType : "other",
    cfErrorOriginPresent: values.has("cf-error-origin"), htmlMarkers: null, htmlTruncated: null
  };
}

export async function reportCodexDiagnostic(callback, value) {
  try { await callback?.(value); } catch { /* Observation cannot change provider behavior. */ }
}

export const codexHtmlError = value => typeof value === "string" && /^\s*[^\r\n<]{0,96}<(?:!doctype|html|head|body)\b/i.test(value);

export function codexHtmlMarkers(value) {
  if (!codexHtmlError(value)) return { htmlMarkers: null, htmlTruncated: null };
  // ponytail: inspect only the first 64 KiB and literal template text, not a full HTML parser; unknown templates stay unclassified.
  const bytes = new TextEncoder().encode(value.slice(0, 65536));
  const htmlTruncated = value.length > 65536 || bytes.length > 65536;
  const html = new TextDecoder().decode(bytes.subarray(0, 65536)).replace(/<!--[\s\S]*?(?:-->|$)|<(script|style)\b[^>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, "");
  const found = new Set();
  const tags = /<([a-z][a-z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  for (const tag of html.matchAll(tags)) {
    if (tag[1].toLowerCase() === "title") {
      const title = html.slice(tag.index + tag[0].length, tag.index + tag[0].length + 256).match(/^([^<]*)<\/title\s*>/i)?.[1].replace(/\s+/g, " ").trim();
      if (title === "Attention Required! | Cloudflare") found.add("cf_attention_required");
      if (title === "Just a moment...") found.add("cf_just_a_moment");
    }
    for (const attr of tag[2].matchAll(/(?:^|\s)([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      if (!["id", "class"].includes(attr[1].toLowerCase())) continue;
      const names = (attr[2] ?? attr[3] ?? attr[4] ?? "").split(/\s+/);
      if (names.includes("cf-error-details")) found.add("cf_error_details");
      if (!names.includes("cf-error-code")) continue;
      found.add("cf_error_code");
      const code = html.slice(tag.index + tag[0].length, tag.index + tag[0].length + 128).match(new RegExp("^\\s*(1020|1009|1015)\\s*</" + tag[1] + "\\s*>", "i"))?.[1];
      if (code) found.add("cf_code_" + code);
    }
  }
  if (html.replace(tags, " ").includes("Sorry, you have been blocked")) found.add("cf_blocked_phrase");
  return { htmlMarkers: [...found], htmlTruncated };
}
