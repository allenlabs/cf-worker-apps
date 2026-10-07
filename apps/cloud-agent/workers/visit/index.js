import { visitDraft, visitErrors, visitIdentity, visitInput, visitJson, visitOutputSize, visitResult, visitReadTarget } from "./contract.js";

export default {
  async fetch(request, env) {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (typeof env.VISIT_SERVICE_TOKEN !== "string" || env.VISIT_SERVICE_TOKEN.length < 32 || request.headers.get("authorization") !== "Bearer " + env.VISIT_SERVICE_TOKEN) return Response.json({ error: "visit_service_denied" }, { status: 403, headers });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/read") return Response.json({ error: "visit_request_invalid" }, { status: 400, headers });
    try {
      const value = await visitJson(request, 4096);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("visit_input_invalid");
      const mcp = Object.hasOwn(value, "identity");
      if (Object.keys(value).some(key => !(mcp ? ["identity", "input"] : ["target", "input"]).includes(key))) throw Error("visit_input_invalid");
      const actor = mcp ? { source: "mcp", ...visitIdentity(value.identity) } : visitReadTarget(value.target), input = visitInput(value.input);
      if (mcp && input.action === "draft") throw Error("visit_input_invalid");
      if (typeof env.TENANT_ID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(env.TENANT_ID) || typeof env.SUPABASE_URL !== "string" || typeof env.SUPABASE_API_KEY !== "string" || env.SUPABASE_API_KEY.length < 16) throw Error("visit_not_configured");
      const origin = new URL(env.SUPABASE_URL);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw Error("visit_not_configured");
      const read = input.action === "draft" ? { action: "visitSelect", patientId: input.patientId, visitId: input.visitId } : input;
      let response;
      try {
        response = await fetch(new URL("/rest/v1/rpc/cloud_agent_visit_read", origin), { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json", apikey: env.SUPABASE_API_KEY, ...(env.SUPABASE_API_KEY.startsWith("eyJ") ? { authorization: "Bearer " + env.SUPABASE_API_KEY } : {}) }, body: JSON.stringify({ p_actor: { tenantId: env.TENANT_ID, ...actor }, p_input: read }) });
      } catch { throw Error("visit_backend_unavailable"); }
      if ([401, 403].includes(response.status)) throw Error("visit_record_denied");
      if (response.status === 404) throw Error("visit_not_found_for_patient");
      if (!response.ok) throw Error("visit_backend_unavailable");
      const context = visitResult(await visitJson(response), read);
      return Response.json(visitOutputSize(input.action === "draft" ? visitDraft(context, input.fields) : context), { headers });
    } catch (error) {
      return Response.json({ error: visitErrors.includes(error.message) ? error.message : "visit_backend_unavailable" }, { status: error.message === "visit_record_denied" ? 403 : 400, headers });
    }
  }
};
