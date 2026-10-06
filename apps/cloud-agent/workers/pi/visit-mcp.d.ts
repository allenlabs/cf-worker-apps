import type { Registry, SubmissionId, SubmissionRecord, TaskId, ConversationId, ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import type { VisitTarget, VisitReadInput, VisitReadResult } from "../visit/contract.js";
import type { VisitGatewayEnvironment } from "../visit/gateway.js";

export type VisitMcpEnvironment = {
  ALLOWED_CHANNEL_ID: string;
  VISIT_MCP_GROUP_ID?: string;
  VISIT_INGRESS_TOKEN?: string;
  VISIT_MCP_API?: VisitGatewayEnvironment["VISIT_API"];
};
export type VisitCaller = { operationId: string; sessionId: string; target: VisitTarget };
export type VisitCallerCandidate = VisitCaller & { state: "running"; submission: SubmissionRecord };
type Context = Parameters<ToolRegistration["execute"]>[2];
export type VisitCallerResolver = (input: { submissionId: SubmissionId; conversationId: ConversationId; taskId: TaskId }, context: Context) => Promise<VisitCallerCandidate | null | undefined>;
export function resolveVisitCaller(input: { api: ToolExecutionApi; context: Context; env: VisitMcpEnvironment; resolveCaller: VisitCallerResolver }): Promise<VisitCaller>;
export function callVisitMcp(env: VisitMcpEnvironment, caller: VisitCaller, input: VisitReadInput, context: Context): Promise<VisitReadResult>;
export function installVisitMcpTools(input: { registry: Registry; env: VisitMcpEnvironment; resolveCaller: VisitCallerResolver }): boolean;
