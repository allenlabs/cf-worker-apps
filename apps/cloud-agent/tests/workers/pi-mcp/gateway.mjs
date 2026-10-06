import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handleChannelVisitMcp } from "../../../workers/visit/channel-mcp.js";
const methods = [];
const createMcpHandler = (server, options) => async request => {
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: options.enableJsonResponse });
  await server.connect(transport);
  return transport.handleRequest(request);
};
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/observed") return Response.json(methods);
    const message = request.method === "POST" ? await request.clone().json() : null;
    if (message?.method) methods.push(message.method);
    if (request.headers.get("x-fixture-mode") === "non-mcp") return Response.json({ mode: "test", kind: "patients", patients: [] });
    if (message?.method === "tools/call" && request.headers.get("x-fixture-mode") === "image") return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "image", data: "YQ==", mimeType: "image/png" }] } });
    return handleChannelVisitMcp(request, { ...env, VISIT_API: { fetch: (url, init) => {
      const headers = new Headers(init.headers); headers.set("x-fixture-mode", request.headers.get("x-fixture-mode") || "normal");
      return env.VISIT_API.fetch(url, { ...init, headers });
    } } }, ctx, createMcpHandler);
  }
};
