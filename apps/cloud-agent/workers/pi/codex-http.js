const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const endpoint = value => {
  try { return new URL(value).href === "https://chatgpt.com/backend-api/codex/responses"; } catch { return null; }
};

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
      let tools = null;
      if (object(body)) {
        if (body.tools === undefined) tools = true;
        else if (Array.isArray(body.tools)) {
          const valid = body.tools.map(tool => !object(tool) || typeof tool.name !== "string" || !tool.name ? false : tool.type === "function" ? object(tool.parameters) : tool.type === "custom" ? object(tool.format) && tool.format.type === "grammar" && ["lark", "regex"].includes(tool.format.syntax) && typeof tool.format.definition === "string" : null);
          tools = valid.includes(false) ? false : valid.includes(null) ? null : true;
        } else tools = false;
      }
      shape.body = { parsedJson: true, storeFalse: object(body) ? body.store === false : false, streamTrue: object(body) ? body.stream === true : false, inputArray: object(body) ? Array.isArray(body.input) : false, toolSchemaValid: tools };
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
