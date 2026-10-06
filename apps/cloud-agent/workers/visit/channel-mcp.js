import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readGatewayVisit } from "./gateway.js";
import { visitErrors, visitInput, visitJson, visitTarget } from "./contract.js";

const route = "/channel-visit/mcp";
const code = error => visitErrors.includes(error?.message) ? error.message : "visit_backend_unavailable";

export async function handleChannelVisitMcp(request, env, ctx, createMcpHandler) {
  const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  if (typeof env.VISIT_INGRESS_TOKEN !== "string" || env.VISIT_INGRESS_TOKEN.length < 32 || request.headers.get("authorization") !== "Bearer " + env.VISIT_INGRESS_TOKEN) return Response.json({ error: "visit_record_denied" }, { status: 403, headers });
  if (new URL(request.url).pathname !== route) return Response.json({ error: "visit_input_invalid" }, { status: 404, headers });
  if (request.method !== "POST") return Response.json({ error: "visit_input_invalid" }, { status: 405, headers: { ...headers, allow: "POST" } });
  if (request.headers.has("origin")) return Response.json({ error: "visit_record_denied" }, { status: 403, headers });
  let server;
  try {
    const raw = request.headers.get("x-cloud-agent-visit-target");
    if (!raw || new TextEncoder().encode(raw).length > 2048) throw Error("visit_target_invalid");
    let target;
    try { target = visitTarget(JSON.parse(raw)); } catch { throw Error("visit_target_invalid"); }
    if (!env.VISIT_MCP_GROUP_ID || target.groupId !== env.VISIT_MCP_GROUP_ID || !env.ALLOWED_CHANNEL_ID || target.channelId !== env.ALLOWED_CHANNEL_ID) throw Error("visit_record_denied");
    const message = await visitJson(request, 8192);
    server = new McpServer({ name: "channel-visit-reads", version: "1.0.0" });
    const read = async value => {
      try {
        const result = await readGatewayVisit(env, { kind: "channel", target }, visitInput(value));
        if (result.mode !== "test") throw Error("visit_record_denied");
        return { content: [{ type: "text", text: JSON.stringify(result) }] };
      } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code(error) }) }] }; }
    };
    const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
    const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
    server.registerTool("search_visit_patients", {
      description: "Search synthetic visit patient labels for the authenticated Channel caller.",
      inputSchema: z.object({ query: z.string().trim().min(2).max(64).refine(value => !value.includes("\0")) }).strict(), annotations
    }, ({ query }) => read({ action: "patientSearch", query }));
    server.registerTool("get_visit_context", {
      description: "Read synthetic visit context for the authenticated Channel caller. An omitted visit leaves selection unset.",
      inputSchema: z.object({ patientId: uuid, visitId: uuid.optional() }).strict(), annotations
    }, ({ patientId, visitId }) => read({ action: "visitSelect", patientId, visitId: visitId ?? null }));
    const response = await createMcpHandler(server, { route, enableJsonResponse: true })(new Request(request.url, { method: "POST", headers: request.headers, body: JSON.stringify(message), signal: request.signal }), env, ctx);
    const safe = new Headers(response.headers); for (const [name, value] of Object.entries(headers)) safe.set(name, value);
    return new Response(response.body, { status: response.status, headers: safe });
  } catch (error) { return Response.json({ error: code(error) }, { status: 400, headers }); }
  finally { if (server) await server.close(); }
}
