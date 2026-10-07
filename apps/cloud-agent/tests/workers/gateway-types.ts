import { readGatewayVisit } from "../../workers/visit/gateway.js";
import type { VisitGatewayEnvironment } from "../../workers/visit/gateway.js";
import { visitIdentity, visitTarget } from "../../workers/visit/contract.js";

declare const env: VisitGatewayEnvironment;
const identity = visitIdentity({ subjectId: "fixture-subject", siteId: "fixture-site" });
const target = visitTarget({ channelId: "fixture-channel", groupId: "fixture-group", rootMessageId: "fixture-root", managerId: "fixture-manager" });
const fields = { kind: "arrival", concernArea: "Confirmed", revision: "no", schedulingExceptions: "None", externalNameChecked: "yes" } satisfies import("../../workers/visit/contract.js").ArrivalFields;
readGatewayVisit(env, { kind: "mcp", identity }, { action: "patientSearch", query: "Synthetic" });
readGatewayVisit(env, { kind: "mcp", identity }, { action: "visitSelect", patientId: "10000000-0000-0000-0000-000000000001" });
readGatewayVisit(env, { kind: "channel", target }, { action: "draft", patientId: "10000000-0000-0000-0000-000000000001", visitId: "20000000-0000-0000-0000-000000000001", fields });
// @ts-expect-error MCP actors have no draft operation.
readGatewayVisit(env, { kind: "mcp", identity }, { action: "draft", patientId: "10000000-0000-0000-0000-000000000001", visitId: "20000000-0000-0000-0000-000000000001", fields });
// @ts-expect-error An actor cannot mix Channel and MCP identity sources.
readGatewayVisit(env, { kind: "mcp", identity, target }, { action: "patientSearch", query: "Synthetic" });
const mixedActor: { kind: "mcp"; identity: typeof identity; target: typeof target } = { kind: "mcp", identity, target };
// @ts-expect-error Mixed variables cannot bypass the exclusive actor variants.
readGatewayVisit(env, mixedActor, { action: "patientSearch", query: "Synthetic" });

const workflow = { schemaVersion: 1, title: "Fixture manual form", source: "none", fields: [{ id: "notice", label: "Notice", type: "text", required: true, maxLength: 100 }], template: "{{notice}}", confirmations: [] } satisfies import("../../workers/pi/workflow.js").WorkflowDefinition;
const visitWorkflow = { ...workflow, source: "visit-context", fields: [{ ...workflow.fields[0], source: "reservation.procedureText" }, { ...workflow.fields[0], id: "concern", source: "intake.concernText" }, { ...workflow.fields[0], id: "pod", maxLength: 40, source: "reservation.pod" }] } satisfies import("../../workers/pi/workflow.js").WorkflowDefinition;
const workflowSend = { action: "send", name: "fixture-form", revision: "0".repeat(64), values: { notice: "Fixture" }, operationId: "fixture-operation", draftToken: "fixture-token", confirmed: true, confirmations: [] } satisfies import("../../workers/pi/workflow.js").WorkflowInput;
void [visitWorkflow, workflowSend];

declare const context: import("../../workers/visit/contract.js").VisitContextResult;
const concern: string | null | undefined = context.intake?.concernText;
const pod: string | null | undefined = context.reservations[0]?.pod;
void [concern, pod];
