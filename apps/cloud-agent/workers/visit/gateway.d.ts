import type { ChannelVisitActor, McpVisitActor, VisitGatewayActor, VisitInput, VisitReadInput, VisitReadResult, VisitResult } from "./contract.js";

export type VisitGatewayEnvironment = {
  VISIT_API: { fetch(url: string, init?: RequestInit): Promise<Response> };
  VISIT_SERVICE_TOKEN: string;
};
export type VisitIngressEnvironment = VisitGatewayEnvironment & { VISIT_INGRESS_TOKEN: string };
export function readGatewayVisit(env: VisitGatewayEnvironment, actor: ChannelVisitActor, input: VisitInput): Promise<VisitResult>;
export function readGatewayVisit(env: VisitGatewayEnvironment, actor: McpVisitActor, input: VisitReadInput): Promise<VisitReadResult>;
export function readGatewayVisit(env: VisitGatewayEnvironment, actor: VisitGatewayActor, input: VisitReadInput): Promise<VisitReadResult>;
export function handleVisitGateway(request: Request, env: VisitIngressEnvironment): Promise<Response>;
