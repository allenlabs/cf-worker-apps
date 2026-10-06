import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VisitIngressEnvironment } from "./gateway.js";

export type ChannelVisitMcpEnvironment = VisitIngressEnvironment & {
  ALLOWED_CHANNEL_ID: string;
  VISIT_MCP_GROUP_ID: string;
};
export type ChannelMcpHandlerFactory<Context> = (
  server: McpServer,
  options: { route: string; enableJsonResponse: true }
) => (request: Request, env: unknown, context: Context) => Promise<Response>;
export function handleChannelVisitMcp<Context>(request: Request, env: ChannelVisitMcpEnvironment, context: Context, createMcpHandler: ChannelMcpHandlerFactory<Context>): Promise<Response>;
