import { visitErrors, visitGatewayActor, visitInput, visitJson, visitOutputSize, visitResult } from "./contract.js";

export async function readGatewayVisit(env, actor, value) {
  const resolved = visitGatewayActor(actor), input = visitInput(value);
  if (resolved.kind === "mcp" && input.action === "draft") throw Error("visit_input_invalid");
  if (!env.VISIT_API || typeof env.VISIT_SERVICE_TOKEN !== "string" || env.VISIT_SERVICE_TOKEN.length < 32) throw Error("visit_not_configured");
  const body = resolved.kind === "channel" ? { target: resolved.target, input } : { identity: resolved.identity, input };
  let response;
  try {
    response = await env.VISIT_API.fetch("https://visit.internal/read", { method: "POST", redirect: "manual", signal: AbortSignal.timeout(15000), headers: { "content-type": "application/json", authorization: "Bearer " + env.VISIT_SERVICE_TOKEN }, body: JSON.stringify(body) });
  } catch { throw Error("visit_backend_unavailable"); }
  const result = await visitJson(response);
  if (!response.ok) throw Error(visitErrors.includes(result?.error) ? result.error : "visit_backend_unavailable");
  return visitOutputSize(visitResult(result, input));
}

export async function handleVisitGateway(request, env) {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (typeof env.VISIT_INGRESS_TOKEN !== "string" || env.VISIT_INGRESS_TOKEN.length < 32 || request.headers.get("authorization") !== "Bearer " + env.VISIT_INGRESS_TOKEN) return Response.json({ error: "visit_service_denied" }, { status: 403, headers });
  if (new URL(request.url).pathname !== "/read") return Response.json({ error: "visit_request_invalid" }, { status: 404, headers });
  if (request.method !== "POST") return Response.json({ error: "visit_request_invalid" }, { status: 405, headers: { ...headers, allow: "POST" } });
  try {
    const value = await visitJson(request, 4096);
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["target", "input"].includes(key))) throw Error("visit_input_invalid");
    const result = await readGatewayVisit(env, { kind: "channel", target: value.target }, value.input);
    return Response.json(result, { headers });
  } catch (error) {
    const code = visitErrors.includes(error.message) ? error.message : "visit_backend_unavailable";
    return Response.json({ error: code }, { status: code === "visit_record_denied" ? 403 : 400, headers });
  }
}
