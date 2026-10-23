const MAX_BODY_BYTES = 1024 * 1024;
const invalid = () => { throw new Error("subscription_model_catalog_unavailable"); };

// SIWC lists the models available to this bearer, unlike the public API model-list shape.
export async function readSiwcModelCatalog(access, supported) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let response, reader;
  try {
    response = await fetch("https://api.openai.com/v1/models", {
      method: "GET", headers: { Authorization: `Bearer ${access}`, Accept: "application/json" },
      redirect: "manual", signal: controller.signal,
    });
    if (response.status !== 200) invalid();
    const contentType = response.headers.get("content-type") || "";
    if (contentType.split(";", 1)[0].trim().toLowerCase() !== "application/json") invalid();
    const charset = contentType.match(/;\s*charset\s*=\s*"?([^;"\s]+)/i)?.[1];
    if (charset && !/^utf-?8$/i.test(charset)) invalid();
    const contentLength = response.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_BODY_BYTES) invalid();
    if (!response.body) invalid();
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let size = 0, body = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) invalid();
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const payload = JSON.parse(body);
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.models) || payload.models.length > 5000) invalid();
    const seen = new Set(), models = [], encoder = new TextEncoder();
    for (const model of payload.models) {
      if (!model || typeof model !== "object" || Array.isArray(model)
        || typeof model.slug !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/.test(model.slug)
        || seen.has(model.slug) || typeof model.visibility !== "string"
        || typeof model.display_name !== "string" || !model.display_name.trim()
        || encoder.encode(model.display_name).length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(model.display_name)) invalid();
      seen.add(model.slug);
      if (model.visibility === "list" && supported.has(model.slug)) models.push({ id: model.slug, name: model.display_name });
    }
    return models;
  } catch {
    invalid();
  } finally {
    clearTimeout(timeout);
    if (reader) void reader.cancel().catch(() => {});
    else if (response?.body) void response.body.cancel().catch(() => {});
  }
}
