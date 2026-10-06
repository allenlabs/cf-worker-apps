const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null;

export function codexDiagnostic(phase, { status, headers }) {
  const values = new Headers(headers);
  const type = values.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const contentType = type === "application/json" || type?.endsWith("+json") ? "json" : type === "text/html" || type === "application/xhtml+xml" ? "html" : type === "text/event-stream" ? "sse" : type ? "other" : "missing";
  const challenge = values.get("cf-mitigated")?.toLowerCase() === "challenge";
  status = Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
  return {
    phase, status,
    category: challenge || contentType === "html" ? "upstream_blocked" : status >= 200 && status < 300 ? "success" : contentType === "json" && status === 401 ? "auth_required" : contentType === "json" && status === 403 ? "permission_denied" : status === 429 ? "rate_limited" : "upstream_error",
    contentType,
    requestId: id(values.get("x-codex-imagegen-request-id")) ?? id(values.get("x-request-id")),
    rayId: id(values.get("cf-ray")), challenge
  };
}

export async function reportCodexDiagnostic(callback, value) {
  try { await callback?.(value); } catch { /* Observation cannot change provider behavior. */ }
}

export const codexHtmlError = value => typeof value === "string" && /^\s*[^\r\n<]{0,96}<(?:!doctype|html|head|body)\b/i.test(value);
