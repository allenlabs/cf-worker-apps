import { callVisitMcp, installVisitMcpTools, resolveVisitCaller } from "../../../workers/pi/visit-mcp.js";
import { createRegistry } from "@earendil-works/pi-durable";

const context = { abortSignal: undefined, name: "fixture", get: () => undefined };
export default {
  async fetch(request, env) {
    const value = await request.json();
    const scoped = { ...env, ...(value.env || {}), VISIT_MCP_API: { fetch: (url, init) => {
      const headers = new Headers(init.headers); headers.set("x-fixture-mode", value.mode || "normal");
      return env.VISIT_MCP_API.fetch(url, { ...init, headers });
    } } };
    try {
      if (new URL(request.url).pathname === "/resolve") {
        const api = { taskId: 7, conversationId: 1, snapshot: async () => value.live || { tools: [{ taskId: 7 }], run: { inputs: [9] } }, memo: async (_name, candidate) => value.memo || candidate };
        return Response.json(await resolveVisitCaller({ api, context, env: scoped, resolveCaller: async () => value.candidate }));
      }
      if (new URL(request.url).pathname === "/tools") {
        const registry = createRegistry();
        installVisitMcpTools({ registry, env: scoped, resolveCaller: async () => value.candidate });
        return Response.json(registry.snapshot().tools().map(({ tool }) => ({ name: tool.name, parameters: tool.parameters })));
      }
      return Response.json(await callVisitMcp(scoped, value.caller, value.input, value.abort ? { ...context, abortSignal: AbortSignal.abort() } : context));
    } catch (error) { return Response.json({ error: error.message }, { status: 400 }); }
  }
};
