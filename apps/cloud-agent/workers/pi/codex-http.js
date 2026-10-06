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
  const shape = { attemptId: crypto.randomUUID(), modelId: typeof modelId === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(modelId) ? modelId : null, expectedEndpoint: endpoint(typeof input === "string" || input instanceof URL ? input : input?.url), method: null, headers: { authorization: null, account: null, contentType: null, accept: null }, body: { parsedJson: null, storeFalse: null, streamTrue: null, inputArray: null, toolSchemaValid: null } };
  try {
    const method = String(init?.method ?? input?.method ?? "GET").toUpperCase();
    shape.method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "CONNECT", "TRACE"].includes(method) ? method : "other";
    const headers = new Headers(init?.headers ?? input?.headers);
    shape.headers = { authorization: headers.has("authorization"), account: headers.has("chatgpt-account-id"), contentType: headers.has("content-type"), accept: headers.has("accept") };
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
  status = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
  const category = challenge ? "upstream_blocked" : status === 403 ? "permission_denied" : status >= 200 && status < 300 ? contentType === "html" ? "invalid_response" : "success" : contentType === "json" && status === 401 ? "auth_required" : status === 429 ? "rate_limited" : "upstream_error";
  return {
    phase, status,
    category, cause: challenge ? "challenge" : category === "success" ? null : "unknown",
    contentType, errorBodyFormat: null,
    requestId: id(values.get("x-codex-imagegen-request-id")) ?? id(values.get("x-request-id")),
    rayId: id(values.get("cf-ray")), challenge
  };
}

export async function reportCodexDiagnostic(callback, value) {
  try { await callback?.(value); } catch { /* Observation cannot change provider behavior. */ }
}

export const codexHtmlError = value => typeof value === "string" && /^\s*[^\r\n<]{0,96}<(?:!doctype|html|head|body)\b/i.test(value);
