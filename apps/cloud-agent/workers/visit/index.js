import { visitDraft, visitInput, visitJson, visitOutputSize, visitResult, visitTarget } from "./contract.js";

export default {
  async fetch(request, env) {
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
    if (typeof env.VISIT_SERVICE_TOKEN !== "string" || env.VISIT_SERVICE_TOKEN.length < 32 || request.headers.get("authorization") !== "Bearer " + env.VISIT_SERVICE_TOKEN) return Response.json({ error: "visit_service_denied" }, { status: 403, headers });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/read") return Response.json({ error: "visit_request_invalid" }, { status: 400, headers });
    try {
      const value = await visitJson(request, 4096);
      if (!value || Array.isArray(value) || Object.keys(value).some(key => !["target", "input"].includes(key))) throw Error("visit_input_invalid");
      const target = visitTarget(value.target), input = visitInput(value.input);
      if (typeof env.TENANT_ID !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(env.TENANT_ID) || typeof env.SUPABASE_URL !== "string" || typeof env.SUPABASE_API_KEY !== "string" || env.SUPABASE_API_KEY.length < 16) throw Error("visit_not_configured");
      const origin = new URL(env.SUPABASE_URL);
      if (origin.protocol !== "https:" || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") throw Error("visit_not_configured");
      const read = input.action === "draft" ? { action: "visitSelect", patientId: input.patientId, visitId: input.visitId } : input;
      let response;
      try {
        response = await fetch(new URL("/rest/v1/rpc/cloud_agent_visit_read", origin), { method: "POST", redirect: "manual", signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json", apikey: env.SUPABASE_API_KEY, ...(env.SUPABASE_API_KEY.startsWith("eyJ") ? { authorization: "Bearer " + env.SUPABASE_API_KEY } : {}) }, body: JSON.stringify({ p_actor: { tenantId: env.TENANT_ID, ...target }, p_input: read }) });
      } catch { throw Error("visit_backend_unavailable"); }
      if ([401, 403].includes(response.status)) throw Error("visit_record_denied");
      if (response.status === 404) throw Error("visit_not_found_for_patient");
      if (!response.ok) throw Error("visit_backend_unavailable");
      const context = visitResult(await visitJson(response), read);
      return Response.json(visitOutputSize(input.action === "draft" ? visitDraft(context, input.fields) : context), { headers });
    } catch (error) {
      const allowed = ["visit_input_invalid", "visit_target_invalid", "visit_selection_required", "visit_not_configured", "visit_record_denied", "visit_not_found_for_patient", "visit_backend_unavailable", "visit_response_invalid", "visit_response_too_large"];
      return Response.json({ error: allowed.includes(error.message) ? error.message : "visit_backend_unavailable" }, { status: ["visit_record_denied"].includes(error.message) ? 403 : 400, headers });
    }
  }
};
